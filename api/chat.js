// Vercel serverless function: POST /api/chat
// Body: { messages: [{ role: "user" | "assistant", content: string }, ...] }
// Streams the assistant reply back as plain text.
//
// Environment variables (set them in the Vercel project settings):
//   GROQ_API_KEY  (required) - your key from https://console.groq.com/keys
//   GROQ_MODEL    (optional) - defaults to openai/gpt-oss-120b
//                  other options: llama-3.3-70b-versatile, openai/gpt-oss-20b, llama-3.1-8b-instant

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 8000;
const MAX_TOTAL_CHARS = 60000;

// Best-effort per-instance rate limit (serverless instances don't share memory).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 15;
const hits = new Map();

const SYSTEM_PROMPT = `You are Radiant AI, a helpful, friendly general-purpose assistant on Samuel Maclar's portfolio website (samuelmaclar.com).

You can help with anything: coding, writing, explanations, brainstorming, math, and everyday questions. Answer clearly and concisely, and use Markdown (headings, lists, fenced code blocks with a language tag) when it helps readability. Keep casual replies short.

If someone asks about the site owner: Samuel Maclar is a full-stack developer and Cyber Security graduate of UMaT (Ghana), doing National Service at Telecel Ghana, and CEO and Founder of Radiant InnovaTech. He builds web systems, AI assistants, business tools, and security-focused products. For anything beyond that, suggest visiting the main portfolio page or contacting Samuel directly rather than guessing.`;

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
  if (messages.length > MAX_MESSAGES) return `conversation is too long (max ${MAX_MESSAGES} messages) — start a new chat`;

  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "user" && m?.role !== "assistant") return "invalid message role";
    if (typeof m.content !== "string" || !m.content.trim()) return "message content must be a non-empty string";
    if (m.content.length > MAX_CHARS_PER_MESSAGE) return `message is too long (max ${MAX_CHARS_PER_MESSAGE} characters)`;
    const expected = i % 2 === 0 ? "user" : "assistant";
    if (m.role !== expected) return "messages must alternate user/assistant, starting with user";
    total += m.content.length;
  }
  if (messages.at(-1).role !== "user") return "last message must be from the user";
  if (total > MAX_TOTAL_CHARS) return "conversation is too long — start a new chat";
  return null;
}

export async function POST(request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return json(500, { error: "The AI service is not configured yet." });
  }

  const ip = (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    return json(429, { error: "Too many requests — please wait a minute and try again." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const problem = validate(body);
  if (problem) return json(400, { error: problem });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...body.messages.map(({ role, content }) => ({ role, content })),
  ];

  let upstream;
  try {
    upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || DEFAULT_MODEL,
        messages,
        stream: true,
        max_completion_tokens: 8192,
      }),
      signal: request.signal,
    });
  } catch (err) {
    console.error("groq fetch failed:", err?.message);
    return json(502, { error: "Could not reach the AI service." });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error("groq error:", upstream.status, detail.slice(0, 500));
    const error =
      upstream.status === 429
        ? "The AI is busy right now — please try again shortly."
        : "The AI service returned an error.";
    return json(upstream.status === 429 ? 429 : 502, { error });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  const out = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let finishReason = null;
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
            const text = choice?.delta?.content;
            if (text) controller.enqueue(encoder.encode(text));
            if (choice?.finish_reason) finishReason = choice.finish_reason;
          }
        }
        if (finishReason === "length") {
          controller.enqueue(encoder.encode("\n\n_(Response was cut off because it reached the length limit.)_"));
        }
      } catch (err) {
        if (!request.signal?.aborted) {
          console.error("chat stream error:", err?.message);
          controller.enqueue(encoder.encode("\n\n_Something went wrong while generating a reply._"));
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
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function GET() {
  return json(405, { error: "Use POST" });
}
