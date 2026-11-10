import Anthropic from "@anthropic-ai/sdk";

// Vercel serverless function: POST /api/chat
// Body: { messages: [{ role: "user" | "assistant", content: string }, ...] }
// Streams the assistant reply back as plain text.
//
// Requires the ANTHROPIC_API_KEY environment variable (set it in the Vercel project settings).

const MODEL = "claude-opus-5-5";
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

let client;
function getClient() {
  client ??= new Anthropic();
  return client;
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
  if (!process.env.ANTHROPIC_API_KEY) {
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

  const messages = body.messages.map(({ role, content }) => ({ role, content }));
  const encoder = new TextEncoder();

  const stream = getClient().beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low" },
      // If the model declines on a safety classifier, let the API retry on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    },
    { signal: request.signal }
  );

  const body$ = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          controller.enqueue(encoder.encode("\n\n_Sorry, I can't help with that request._"));
        } else if (final.stop_reason === "max_tokens") {
          controller.enqueue(encoder.encode("\n\n_(Response was cut off because it reached the length limit.)_"));
        }
      } catch (err) {
        if (!request.signal?.aborted) {
          console.error("chat stream error:", err?.status, err?.message);
          const msg =
            err instanceof Anthropic.RateLimitError
              ? "The AI is busy right now — please try again shortly."
              : "Something went wrong while generating a reply.";
          controller.enqueue(encoder.encode(`\n\n_${msg}_`));
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      stream.abort();
    },
  });

  return new Response(body$, {
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
