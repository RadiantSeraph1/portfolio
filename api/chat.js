// Vercel serverless function: POST /api/chat
// Body: { messages: [{ role: "user" | "assistant", content: string }, ...], search?: boolean }
//
// GET /api/chat returns the models that are available: { providers: [{ id, label, models: [{ id, search }] }] }.
// POST also accepts optional { provider, model } to try that model first (the rest remain as fallbacks).
//
// Streams newline-delimited JSON events back to the browser:
//   {"type":"status","value":"thinking" | "searching"}
//   {"type":"text","value":"..."}            (answer text, in pieces)
//   {"type":"sources","value":[{title,url}]}  (web pages used, if any)
//   {"type":"model","value":{provider,model}} (which model actually answered)
//   {"type":"error","value":"..."}           (something went wrong mid-reply)
//
// Environment variables (set them in the Vercel project settings). At least one key is required:
//   NVIDIA_API_KEY     - NVIDIA NIM key from https://build.nvidia.com (starts with nvapi-)
//   NVIDIA_MODEL       - optional first NVIDIA model; defaults to nvidia/nemotron-3.5-lightning-30b-a3b
//   GROQ_API_KEY       - key from https://console.groq.com/keys
//   GROQ_MODEL         - optional first Groq model; defaults to openai/gpt-oss-120b
//   GEMINI_API_KEY     - key from https://aistudio.google.com (Get API key)
//   GEMINI_MODEL       - optional first Gemini model; defaults to gemini-3.8-flash
//   VERTEX_API_KEY     - Vertex AI express-mode key (Google Cloud console > Vertex AI)
//   VERTEX_MODEL       - optional first Vertex model; defaults to gemini-3-flash-preview
//   AI_PROVIDER_ORDER  - optional, e.g. "nvidia,groq,vertex,gemini" (the default)
//
// Every provider and model has its own rate limit, so when one is busy (HTTP 429) or failing,
// the request moves on to the next model in the chain instead of showing an error.

// NVIDIA NIM hosted API (OpenAI-compatible chat completions).
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODELS = ["nvidia/nemotron-3.5-lightning-30b-a3b", "openai/gpt-oss-120b", "meta/llama-3.3-70b-instruct"];

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];

// Vertex AI express mode (API key, no project/location in the URL).
const VERTEX_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models";
const VERTEX_MODELS = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"];

const MAX_OUTPUT_TOKENS = 4096;

// Only the most recent part of a long chat is sent, to keep requests fast and within
// tokens-per-minute limits. (The full chat is still saved in the browser.)
const CONTEXT_MAX_MESSAGES = 12;
const CONTEXT_MAX_CHARS = 14000;
const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 8000;
const MAX_TOTAL_CHARS = 60000;

// Best-effort per-instance rate limit (serverless instances don't share memory).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 15;
const hits = new Map();

function systemPrompt(searchEnabled, searchWanted = false) {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Accra",
  });

  return `You are Radiant AI, a helpful, knowledgeable assistant on Samuel Maclar's portfolio website (samuelmaclar.com). Today is ${today}.

How to answer:
- Help with anything: research, coding, writing, explanations, brainstorming, math, and everyday questions.
- Be accurate. Never invent facts, figures, dates, names, quotes, or links. If you are not sure, say so plainly instead of guessing.
- ${
    searchEnabled
      ? "You can search the web. Only search when the answer depends on current, time-sensitive, or very specific facts (news, prices, recent events, specific companies or people). Do NOT search for general knowledge, definitions, concepts, coding, writing, or casual chat; answer those directly. When you do search, one or two well-chosen searches are usually enough."
      : searchWanted
        ? "You cannot browse the web with this model. For current or very specific facts (companies, prices, news, recent events), give what you know and say it may be out of date."
        : "You cannot browse the web right now. For current or very specific facts (companies, prices, news, recent events), give what you know, say it may be out of date, and suggest the user turn on web search."
  }
- Match length to the question: short and direct for simple questions; well-structured (headings, bullet points, tables) for research or detailed explanations.
- Use Markdown. Put code in fenced code blocks with a language tag.
- For research requests, cover the key facts, recent developments, and useful context, then offer to go deeper on a specific angle.

About the site owner: Samuel Maclar is a full-stack developer and Cyber Security graduate of UMaT (Ghana), doing National Service at Telecel Ghana, and CEO and Founder of Radiant InnovaTech. He builds web systems, AI assistants, business tools, and security-focused products.
- Only talk about Samuel when the user asks about him. Never bring him up on your own, never suggest contacting or messaging him, and never claim anything about his availability, colleagues, or internal company tools.
- You cannot verify who you are talking to. If someone says they are Samuel, be friendly but don't treat them differently.
- For questions about Samuel beyond the facts above, point to the main portfolio page.`;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_MAX_REQUESTS;
}

function validate(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return "messages must be a non-empty array";
  if (messages.length > MAX_MESSAGES) return `This chat is too long (max ${MAX_MESSAGES} messages). Please start a new chat.`;

  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "user" && m?.role !== "assistant") return "invalid message role";
    if (typeof m.content !== "string" || !m.content.trim()) return "message content must be a non-empty string";
    if (m.content.length > MAX_CHARS_PER_MESSAGE) return `Your message is too long (max ${MAX_CHARS_PER_MESSAGE} characters).`;
    const expected = i % 2 === 0 ? "user" : "assistant";
    if (m.role !== expected) return "messages must alternate user/assistant, starting with user";
    total += m.content.length;
  }
  if (messages.at(-1).role !== "user") return "last message must be from the user";
  if (total > MAX_TOTAL_CHARS) return "This chat is too long. Please start a new chat.";
  return null;
}

// Keep the latest messages that fit the context budget; the kept part must start with a user message.
function recentHistory(messages) {
  const kept = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, content } = messages[i];
    if (kept.length >= CONTEXT_MAX_MESSAGES) break;
    if (kept.length && chars + content.length > CONTEXT_MAX_CHARS) break;
    kept.unshift({ role, content });
    chars += content.length;
  }
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return kept;
}

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

/** The ordered list of {provider, model} attempts, based on which keys are configured. */
function buildChain() {
  const chains = {
    nvidia: process.env.NVIDIA_API_KEY
      ? unique([process.env.NVIDIA_MODEL, ...NVIDIA_MODELS]).map((model) => ({ provider: "nvidia", model }))
      : [],
    groq: process.env.GROQ_API_KEY
      ? unique([process.env.GROQ_MODEL, ...GROQ_MODELS]).map((model) => ({ provider: "groq", model }))
      : [],
    vertex: process.env.VERTEX_API_KEY
      ? unique([process.env.VERTEX_MODEL, ...VERTEX_MODELS]).map((model) => ({ provider: "vertex", model }))
      : [],
    gemini: process.env.GEMINI_API_KEY
      ? unique([process.env.GEMINI_MODEL, ...GEMINI_MODELS]).map((model) => ({ provider: "gemini", model }))
      : [],
  };
  const order = unique([
    ...(process.env.AI_PROVIDER_ORDER || "").toLowerCase().split(/[\s,]+/),
    "nvidia",
    "groq",
    "vertex",
    "gemini",
  ]);
  return order.flatMap((name) => chains[name] || []);
}

// ---------------------------------------------------------------------------
// Groq (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

const groqSupportsSearch = (model) => model.startsWith("openai/gpt-oss");

function callGroq({ model, history, search, searchWanted, safe, signal }) {
  const payload = {
    model,
    messages: [{ role: "system", content: systemPrompt(search, searchWanted) }, ...history],
    stream: true,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
  };
  // Low effort is much faster and is what Groq recommends with browser search.
  if (groqSupportsSearch(model) && !safe) payload.reasoning_effort = "low";
  if (search) {
    payload.tools = [{ type: "browser_search" }];
    payload.tool_choice = "auto";
  }
  return fetch(GROQ_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

// Pull {title, url} pairs out of Groq's executed tool output, whatever shape it arrives in.
function collectGroqSources(tools, into) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    for (const list of [tool?.search_results?.results, tool?.search_results, tool?.results]) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (!isHttpUrl(r?.url) || into.has(r.url)) continue;
        into.set(r.url, { title: String(r.title || r.url).slice(0, 200), url: r.url });
      }
    }
  }
}

function handleGroqChunk(chunk, out) {
  if (chunk.error) throw new Error(chunk.error.message || "stream error");
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  if (delta.executed_tools || delta.tool_calls) {
    out.status("searching");
    collectGroqSources(delta.executed_tools, out.sources);
  }
  collectGroqSources(chunk.x_groq?.executed_tools, out.sources);
  if (typeof delta.content === "string" && delta.content) out.text(delta.content);
  if (choice?.finish_reason === "length") out.cutOff = true;
}

// ---------------------------------------------------------------------------
// Google Gemini (Gemini API with an AI Studio key, or Vertex AI express mode)
// ---------------------------------------------------------------------------

const geminiSupportsThinkingLevel = (model) => /^gemini-([3-9]|\d\d)/.test(model);

/** Build a call function for a Gemini endpoint (Gemini API or Vertex AI express mode). */
function geminiCaller({ baseUrl, keyEnv, searchTool }) {
  return function callGoogle({ model, history, search, searchWanted, safe, signal }) {
    const generationConfig = { maxOutputTokens: MAX_OUTPUT_TOKENS };
    // Gemini 3+ thinks by default; a low thinking level keeps replies fast.
    if (!safe && geminiSupportsThinkingLevel(model)) generationConfig.thinkingConfig = { thinkingLevel: "low" };

    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt(search, searchWanted) }] },
      contents: history.map(({ role, content }) => ({
        role: role === "assistant" ? "model" : "user",
        parts: [{ text: content }],
      })),
      generationConfig,
    };
    if (search) payload.tools = [searchTool];

    return fetch(`${baseUrl}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": process.env[keyEnv], "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  };
}

const callGemini = geminiCaller({ baseUrl: GEMINI_URL, keyEnv: "GEMINI_API_KEY", searchTool: { google_search: {} } });
const callVertex = geminiCaller({ baseUrl: VERTEX_URL, keyEnv: "VERTEX_API_KEY", searchTool: { googleSearch: {} } });

const GEMINI_BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);

function handleGeminiChunk(chunk, out) {
  if (chunk.error) throw new Error(chunk.error.message || "stream error");
  if (chunk.promptFeedback?.blockReason) out.blocked = true;

  const candidate = chunk.candidates?.[0];
  if (!candidate) return;

  const grounding = candidate.groundingMetadata;
  if (grounding?.webSearchQueries?.length) out.status("searching");
  for (const c of grounding?.groundingChunks || []) {
    const web = c?.web;
    if (!isHttpUrl(web?.uri) || out.sources.has(web.uri)) continue;
    out.sources.set(web.uri, { title: String(web.title || web.uri).slice(0, 200), url: web.uri });
  }

  for (const part of candidate.content?.parts || []) {
    if (part.thought) continue; // thinking summaries are not part of the answer
    if (typeof part.text === "string" && part.text) out.text(part.text);
  }

  if (candidate.finishReason === "MAX_TOKENS") out.cutOff = true;
  if (GEMINI_BLOCKED.has(candidate.finishReason)) out.blocked = true;
}

// ---------------------------------------------------------------------------
// NVIDIA NIM (OpenAI-compatible chat completions; no built-in web search)
// ---------------------------------------------------------------------------

function callNvidia({ model, history, searchWanted, signal }) {
  return fetch(NVIDIA_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt(false, searchWanted) }, ...history],
      stream: true,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.6,
    }),
    signal,
  });
}

// Some reasoning models put their thinking inline between <think> and </think>; hide it.
function visibleText(piece, out) {
  let buf = (out.thinkBuf || "") + piece;
  let shown = "";
  while (buf) {
    if (out.inThink) {
      const end = buf.indexOf("</think>");
      if (end === -1) {
        buf = buf.slice(-7); // keep a possible partial closing tag
        break;
      }
      buf = buf.slice(end + 8);
      out.inThink = false;
    } else {
      const start = buf.indexOf("<think>");
      if (start !== -1) {
        shown += buf.slice(0, start);
        buf = buf.slice(start + 7);
        out.inThink = true;
        continue;
      }
      const keep = ["<think", "<thin", "<thi", "<th", "<t", "<"].find((p) => buf.endsWith(p)) || "";
      shown += buf.slice(0, buf.length - keep.length);
      buf = keep;
      break;
    }
  }
  out.thinkBuf = buf;
  return shown;
}

function handleNvidiaChunk(chunk, out) {
  if (chunk.error) throw new Error(chunk.error.message || "stream error");
  const choice = chunk.choices?.[0];
  const content = choice?.delta?.content; // reasoning_content (thinking) is deliberately ignored
  if (typeof content === "string" && content) {
    const text = visibleText(content, out);
    if (text) out.text(text);
  }
  if (choice?.finish_reason === "length") out.cutOff = true;
}

const PROVIDERS = {
  nvidia: { call: callNvidia, handle: handleNvidiaChunk, supportsSearch: () => false },
  groq: { call: callGroq, handle: handleGroqChunk, supportsSearch: groqSupportsSearch },
  gemini: { call: callGemini, handle: handleGeminiChunk, supportsSearch: () => true },
  vertex: { call: callVertex, handle: handleGeminiChunk, supportsSearch: () => true },
};

const PROVIDER_LABELS = { nvidia: "NVIDIA NIM", groq: "Groq", vertex: "Google Vertex AI", gemini: "Google Gemini" };

/** What the model picker shows: only providers whose key is configured. No secrets. */
function catalog() {
  const providers = [];
  for (const attempt of buildChain()) {
    let entry = providers.find((p) => p.id === attempt.provider);
    if (!entry) {
      entry = { id: attempt.provider, label: PROVIDER_LABELS[attempt.provider] || attempt.provider, models: [] };
      providers.push(entry);
    }
    entry.models.push({ id: attempt.model, search: PROVIDERS[attempt.provider].supportsSearch(attempt.model) });
  }
  return { providers };
}

// A model that just timed out, was rate-limited or errored is tried last for a while, so one
// overloaded model doesn't add a long wait to every message. (Per warm serverless instance.)
const COOLDOWN_MS = 90_000;
const cooling = new Map();
const modelKey = (a) => `${a.provider}:${a.model}`;
const isCooling = (a) => (cooling.get(modelKey(a)) || 0) > Date.now();
const startCooldown = (a) => {
  cooling.set(modelKey(a), Date.now() + COOLDOWN_MS);
  if (cooling.size > 200) cooling.clear();
};
const shouldCool = (status) => status === 429 || status >= 500;

/** Models that are cooling down move to the back, unless the user picked that one on purpose. */
function demoteCooling(chain, explicit) {
  const ready = chain.filter((a) => a === explicit || !isCooling(a));
  return [...ready, ...chain.filter((a) => a !== explicit && isCooling(a))];
}

/** Put the user's chosen model first (if it is available); the rest stay as fallbacks. */
function applyChoice(chain, body) {
  const { provider, model } = body || {};
  if (typeof provider !== "string" || typeof model !== "string") return chain;
  const index = chain.findIndex((a) => a.provider === provider && a.model === model);
  if (index <= 0) return chain;
  return [chain[index], ...chain.slice(0, index), ...chain.slice(index + 1)];
}

// ---------------------------------------------------------------------------
// Shared streaming helpers
// ---------------------------------------------------------------------------

// Remove gpt-oss citation markers such as 【2†L6-L10】 from the visible answer.
function stripCitationMarkers(text) {
  return text.replace(/[ \t]*【[^】]*】/g, "");
}

/** Yield the parsed JSON of each `data:` line of a server-sent event stream. */
async function* sseJson(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {
        // ignore malformed lines
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Time limits (Vercel stops the function at 60s; see vercel.json).
const ATTEMPT_CONNECT_TIMEOUT_MS = 20_000; // max wait for a provider to start responding
const FIRST_TEXT_TIMEOUT_MS = 40_000; // max wait for the first words before trying the next model
const IDLE_TIMEOUT_MS = 25_000; // max silence once an answer is streaming
const TOTAL_BUDGET_MS = 52_000; // stop starting new attempts after this
const PING_INTERVAL_MS = 8_000; // keep-alive so proxies don't drop a quiet connection

/** Short, non-secret reason for a failed upstream response, for the diagnostics line. */
async function failureReason(res) {
  const raw = await res.text().catch(() => "");
  let reason = "";
  if ([400, 401, 403].includes(res.status)) {
    try {
      const e = JSON.parse(raw).error || {};
      reason = [e.status, e.message].filter(Boolean).join(": ");
    } catch {
      reason = raw;
    }
    reason = reason.replace(/\b(org|key|sk|gsk|AIza|nvapi)[\w-]{6,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 120);
  }
  return { raw: raw.slice(0, 300), reason };
}

/** An AbortSignal that fires when the client disconnects or the (resettable) timer runs out. */
function withTimeout(parent, ms) {
  const ctrl = new AbortController();
  let timer = null;
  const arm = (t) => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error("timeout")), t);
  };
  const onAbort = () => ctrl.abort(parent.reason);
  parent?.addEventListener?.("abort", onAbort, { once: true });
  arm(ms);
  return {
    signal: ctrl.signal,
    reset: arm,
    clear() {
      clearTimeout(timer);
      parent?.removeEventListener?.("abort", onAbort);
    },
  };
}

export async function POST(request) {
  let chain = buildChain();
  if (!chain.length) {
    return json(500, { error: "The AI service is not configured yet." });
  }

  const ip = (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    return json(429, { error: "You're sending messages too quickly. Please wait a minute and try again." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid request." });
  }

  const problem = validate(body);
  if (problem) return json(400, { error: problem });
  chain = applyChoice(chain, body);
  const explicit = chain[0] && chain[0].provider === body.provider && chain[0].model === body.model ? chain[0] : null;
  chain = demoteCooling(chain, explicit);

  const wantSearch = body.search !== false;
  const history = recentHistory(body.messages);
  const started = Date.now();
  const encoder = new TextEncoder();
  let activeReader = null;

  // Respond straight away and do all provider work inside the stream, so the browser's
  // connection is established immediately and a failing provider can be swapped for the
  // next one without the user seeing an error.
  const out = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (type, value) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify({ type, value }) + "\n"));
      };
      const ping = setInterval(() => send("ping", Date.now() - started), PING_INTERVAL_MS);

      let status = null;
      let sentText = false;
      let pendingText = ""; // holds a possibly-unfinished 【...】 marker between chunks
      const trace = [];

      const emitText = (piece, final = false) => {
        pendingText += piece;
        let ready = pendingText;
        const open = ready.lastIndexOf("【");
        if (!final && open !== -1 && ready.indexOf("】", open) === -1) {
          ready = pendingText.slice(0, open);
          pendingText = pendingText.slice(open);
        } else {
          pendingText = "";
        }
        if (!final) {
          // Hold back trailing spaces so a marker in the next chunk can take them with it.
          const trimmed = ready.replace(/[ \t]+$/, "");
          pendingText = ready.slice(trimmed.length) + pendingText;
          ready = trimmed;
        }
        ready = stripCitationMarkers(ready);
        if (ready) {
          sentText = true;
          send("text", ready);
        }
      };

      const setStatus = (s) => {
        if (s !== status && !sentText) {
          status = s;
          send("status", s);
        }
      };

      setStatus("thinking");

      let answered = false;
      let blocked = false;
      let sawBusy = false;
      const deadProviders = new Set(); // providers whose key was rejected
      const isKeyProblem = (status, reason) =>
        status === 401 || status === 403 || /api[ _-]?key|permission|unauthenticated/i.test(reason || "");

      try {
        for (const attempt of chain) {
          if (request.signal?.aborted) break;
          if (Date.now() - started > TOTAL_BUDGET_MS) {
            trace.push(`${attempt.provider}:${attempt.model}=skipped(time)`);
            continue;
          }

          if (deadProviders.has(attempt.provider)) continue;
          const provider = PROVIDERS[attempt.provider];
          const search = wantSearch && provider.supportsSearch(attempt.model);
          const label = `${attempt.provider}:${attempt.model}`;
          const timer = withTimeout(request.signal, ATTEMPT_CONNECT_TIMEOUT_MS);

          try {
            const args = { model: attempt.model, history, searchWanted: wantSearch, signal: timer.signal };
            let res = await provider.call({ ...args, search, safe: false });

            // A 400 usually means an unsupported option (search tool or thinking setting on this
            // model/plan): retry the same model once with plain settings.
            if (res.status === 400) {
              const { raw, reason } = await failureReason(res);
              console.warn(`${label} rejected request, retrying plain:`, raw);
              trace.push(`${label}=400(${reason})`);
              if (isKeyProblem(400, reason)) {
                deadProviders.add(attempt.provider);
                continue;
              }
              res = await provider.call({ ...args, search: false, safe: true });
            }

            if (!res.ok || !res.body) {
              const { raw, reason } = await failureReason(res);
              console.warn(`${label} failed with ${res.status}:`, raw);
              trace.push(`${label}=${res.status}${reason ? `(${reason})` : ""}`);
              if (res.status === 429) sawBusy = true;
              if (shouldCool(res.status)) startCooldown(attempt);
              if (isKeyProblem(res.status, reason)) deadProviders.add(attempt.provider);
              continue;
            }

            // Stream this provider's answer.
            const state = {
              sources: new Map(),
              cutOff: false,
              blocked: false,
              text: (t) => emitText(t),
              status: setStatus,
            };
            const reader = res.body.getReader();
            activeReader = reader;
            timer.reset(FIRST_TEXT_TIMEOUT_MS);

            for await (const chunk of sseJson(reader)) {
              provider.handle(chunk, state);
              // Once words are flowing, only give up if the stream goes silent for too long.
              if (sentText) timer.reset(IDLE_TIMEOUT_MS);
            }
            emitText("", true);

            if (!sentText) {
              // Finished without an answer: refused/blocked, or empty. Try the next model.
              trace.push(`${label}=${state.blocked ? "blocked" : "empty"}`);
              if (state.blocked) blocked = true;
              continue;
            }

            trace.push(`${label}=ok`);
            send("model", { provider: attempt.provider, model: attempt.model });
            if (state.cutOff) {
              send("text", "\n\n_(The answer was cut off because it reached the length limit. Ask me to continue.)_");
            }
            if (state.sources.size) send("sources", [...state.sources.values()].slice(0, 8));
            answered = true;
            break;
          } catch (err) {
            if (request.signal?.aborted) break;
            const why = timer.signal.aborted ? "timeout" : "error";
            if (!sentText) startCooldown(attempt);
            console.warn(`${label} ${why}:`, err?.message);
            trace.push(`${label}=${why}`);
            if (sentText) {
              // The answer was already partly shown; we can't switch models mid-sentence.
              send("error", "The connection to the AI was interrupted. Please try again.");
              answered = true;
              break;
            }
          } finally {
            timer.clear();
            activeReader = null;
          }
        }

        if (!answered && !request.signal?.aborted) {
          send(
            "error",
            blocked
              ? "Sorry, I can't help with that request. Try rephrasing it."
              : sawBusy
                ? "Radiant AI is getting a lot of messages right now. Please wait about a minute and try again."
                : "The AI service had a problem answering. Please try again."
          );
        }
      } catch (err) {
        console.error("chat handler error:", err?.message);
        if (!sentText) send("error", "Something went wrong. Please try again.");
      } finally {
        // Which provider answered and why others were skipped (no secrets). Ignored by the page.
        send("debug", trace.join("; "));
        console.log("chat trace:", trace.join("; "));
        clearInterval(ping);
        closed = true;
        controller.close();
      }
    },
    cancel() {
      activeReader?.cancel().catch(() => {});
    },
  });

  return new Response(out, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

export function GET() {
  return new Response(JSON.stringify(catalog()), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
  });
}
