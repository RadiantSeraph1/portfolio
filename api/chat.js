// Vercel serverless function: POST /api/chat
// Body: { messages: [{ role: "user" | "assistant", content: string }, ...], search?: boolean }
//
// Streams newline-delimited JSON events back to the browser:
//   {"type":"status","value":"thinking" | "searching"}
//   {"type":"text","value":"..."}            (answer text, in pieces)
//   {"type":"sources","value":[{title,url}]}  (web pages used, if any)
//   {"type":"error","value":"..."}           (something went wrong mid-reply)
//
// Environment variables (set them in the Vercel project settings):
//   GROQ_API_KEY  (required) - your key from https://console.groq.com/keys
//   GROQ_MODEL    (optional) - first model to try; defaults to openai/gpt-oss-120b
//                  Web search only works with openai/gpt-oss-120b or openai/gpt-oss-20b.
//
// Groq rate-limits each model separately, so when one model is busy (HTTP 429) or failing,
// the request moves on to the next model in FALLBACK_MODELS instead of showing an error.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

// Only the most recent part of a long chat is sent, to keep requests fast and within Groq's
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

function systemPrompt(searchEnabled) {
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

// Remove gpt-oss citation markers such as 【2†L6-L10】 from the visible answer.
function stripCitationMarkers(text) {
  return text.replace(/[ \t]*【[^】]*】/g, "");
}

// Pull {title, url} pairs out of Groq's executed tool output, whatever shape it arrives in.
function collectSources(tools, into) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    const lists = [tool?.search_results?.results, tool?.search_results, tool?.results];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const url = typeof r?.url === "string" ? r.url : null;
        if (!url || !/^https?:\/\//i.test(url) || into.has(url)) continue;
        into.set(url, { title: String(r.title || url).slice(0, 200), url });
      }
    }
  }
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

async function callGroq({ apiKey, model, messages, search, signal }) {
  const isGptOss = model.startsWith("openai/gpt-oss");
  const payload = {
    model,
    messages,
    stream: true,
    max_completion_tokens: 4096,
  };
  // Low effort is much faster and is what Groq recommends with browser search.
  if (isGptOss) payload.reasoning_effort = "low";
  if (search && isGptOss) {
    payload.tools = [{ type: "browser_search" }];
    payload.tool_choice = "auto";
  }

  return fetch(GROQ_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
}

export async function POST(request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
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

  const primary = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const models = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];
  const wantSearch = body.search !== false;
  const history = recentHistory(body.messages);

  const buildMessages = (withSearch) => [{ role: "system", content: systemPrompt(withSearch) }, ...history];

  let upstream = null;
  let lastStatus = 0;
  try {
    for (const model of models) {
      let search = wantSearch && model.startsWith("openai/gpt-oss");
      upstream = await callGroq({ apiKey, model, messages: buildMessages(search), search, signal: request.signal });

      // If web search is rejected (e.g. unsupported on this plan), answer without it rather than failing.
      if (search && upstream.status === 400) {
        const detail = await upstream.text().catch(() => "");
        console.warn(`groq rejected search on ${model}, retrying without tools:`, detail.slice(0, 300));
        search = false;
        upstream = await callGroq({ apiKey, model, messages: buildMessages(false), search: false, signal: request.signal });
      }

      if (upstream.ok && upstream.body) break;

      lastStatus = upstream.status;
      const detail = await upstream.text().catch(() => "");
      console.warn(`groq ${model} failed with ${upstream.status}:`, detail.slice(0, 300));
      upstream = null;

      // Only busy/overloaded/server errors are worth trying on another model.
      if (lastStatus !== 429 && lastStatus !== 404 && lastStatus < 500) break;
    }
  } catch (err) {
    if (request.signal?.aborted) return new Response(null, { status: 499 });
    console.error("groq fetch failed:", err?.message);
    return json(502, { error: "Couldn't reach the AI service. Please try again." });
  }

  if (!upstream) {
    const error =
      lastStatus === 429
        ? "Radiant AI is getting a lot of messages right now. Please wait about a minute and try again."
        : "The AI service had a problem answering. Please try again.";
    return json(lastStatus === 429 ? 429 : 502, { error });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  const out = new ReadableStream({
    async start(controller) {
      const send = (type, value) => controller.enqueue(encoder.encode(JSON.stringify({ type, value }) + "\n"));
      const sources = new Map();
      let buffer = "";
      let finishReason = null;
      let status = null;
      let sentText = false;
      let pendingText = ""; // holds a possibly-unfinished 【...】 marker between chunks

      const setStatus = (s) => {
        if (s !== status && !sentText) {
          status = s;
          send("status", s);
        }
      };

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

      setStatus("thinking");

      try {
        // Groq streams OpenAI-style server-sent events: "data: {json}\n\n", ending with "data: [DONE]".
        outer: while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;

            const data = line.slice(5).trim();
            if (data === "[DONE]") break outer;

            let chunk;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            if (chunk.error) throw new Error(chunk.error.message || "stream error");

            const choice = chunk.choices?.[0];
            const delta = choice?.delta || {};

            if (delta.executed_tools || delta.tool_calls) {
              setStatus("searching");
              collectSources(delta.executed_tools, sources);
            }
            collectSources(chunk.x_groq?.executed_tools, sources);

            if (typeof delta.content === "string" && delta.content) emitText(delta.content);
            if (choice?.finish_reason) finishReason = choice.finish_reason;
          }
        }

        emitText("", true);

        if (!sentText) {
          send("error", "The AI didn't return an answer. Please try again.");
        } else if (finishReason === "length") {
          send("text", "\n\n_(The answer was cut off because it reached the length limit. Ask me to continue.)_");
        }
        if (sources.size) send("sources", [...sources.values()].slice(0, 8));
      } catch (err) {
        if (!request.signal?.aborted) {
          console.error("chat stream error:", err?.message);
          send("error", "The connection to the AI was interrupted. Please try again.");
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(out, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function GET() {
  return json(405, { error: "Use POST" });
}
