// POST /api/export  { format: "docx" | "pdf" | "xlsx" | "pptx", spec: {...} }  ->  the file as a download.
//
// Open to everyone: the file is built from content the visitor already has in their chat, nothing is
// stored, and no Drive, account, or secret is involved. Abuse is limited by size caps (see _files.js),
// a request body limit, and a best-effort per-instance rate limit.

import { FORMATS, FileSpecError, fileName, normalizeSpec } from "./_files.js";
import { renderers } from "./_render.js";

const MAX_BODY_BYTES = 400_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const hits = new Map();

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_MAX;
}

export async function POST(request) {
  const ip = (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return json(429, { error: "You're downloading too quickly. Please wait a minute and try again." });

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "That document is too large to export." });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Invalid request." });
  }

  const format = typeof body?.format === "string" ? body.format : "";
  const info = FORMATS[format];
  if (!info) return json(400, { error: "Unknown file format." });

  let spec;
  try {
    spec = normalizeSpec(body.spec);
  } catch (err) {
    if (err instanceof FileSpecError) return json(400, { error: err.message });
    throw err;
  }
  if (spec.type !== info.type) return json(400, { error: `A ${spec.type} can't be exported as ${format}.` });

  try {
    const bytes = await renderers[format](spec);
    const name = fileName(spec.title, format);
    return new Response(bytes, {
      headers: {
        "content-type": info.mime,
        "content-disposition": `attachment; filename="${name}"`,
        "content-length": String(bytes.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    console.error("export failed:", format, err?.message);
    return json(500, { error: "Sorry, that file couldn't be created. Please try again." });
  }
}

export function GET() {
  return json(405, { error: "Use POST" });
}
