// Owner-only chat sync: POST /api/sync?action=login, GET /api/sync, POST /api/sync
//
// Environment variables:
//   OWNER_PASSWORD                         (required) password for signing in to sync
//   SYNC_SECRET                            (optional) extra secret for signing sessions;
//                                          changing it (or the password) signs out every device
//   KV_REST_API_URL / KV_REST_API_TOKEN    set by the Vercel Upstash integration
//   (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
//
// Storage (Redis hashes):
//   sync:chats    id -> chat JSON
//   sync:deleted  id -> deletion timestamp (so other devices remove it too)

import { redis, pipeline, redisConfigured } from "./_redis.js";
import { isOwner, makeToken, sameText } from "./_auth.js";

const CHATS_KEY = "sync:chats";
const DELETED_KEY = "sync:deleted";
const MAX_CHATS = 500;
const MAX_CHAT_BYTES = 300_000;
const MAX_BATCH = 50;
const LOGIN_MAX_FAILS = 8; // per IP per 15 minutes
const ID_RE = /^[\w-]{1,64}$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Check and normalise a chat object from the browser. Returns null if invalid. */
function cleanChat(chat) {
  if (!chat || typeof chat !== "object") return null;
  if (typeof chat.id !== "string" || !ID_RE.test(chat.id)) return null;
  if (!Number.isFinite(chat.updated)) return null;
  if (!Array.isArray(chat.messages) || chat.messages.length > 200) return null;

  const messages = [];
  for (const m of chat.messages) {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m.content !== "string") return null;
    const msg = { role: m.role, content: m.content };
    if (Array.isArray(m.sources)) {
      msg.sources = m.sources
        .filter((s) => typeof s?.url === "string" && /^https?:\/\//i.test(s.url))
        .slice(0, 10)
        .map((s) => ({ title: String(s.title || s.url).slice(0, 200), url: s.url.slice(0, 2000) }));
    }
    messages.push(msg);
  }

  const clean = {
    id: chat.id,
    title: String(chat.title || "Chat").slice(0, 200),
    updated: Math.floor(chat.updated),
    messages,
  };
  return JSON.stringify(clean).length <= MAX_CHAT_BYTES ? clean : null;
}

async function login(request) {
  if (!process.env.OWNER_PASSWORD) return json(500, { error: "Sync isn't set up yet (no OWNER_PASSWORD)." });

  const ip = (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const failKey = `sync:fails:${ip}`;
  const fails = Number((await redis(["GET", failKey])) || 0);
  if (fails >= LOGIN_MAX_FAILS) return json(429, { error: "Too many attempts. Try again in 15 minutes." });

  const body = await request.json().catch(() => ({}));
  if (typeof body.password !== "string" || !sameText(body.password, process.env.OWNER_PASSWORD)) {
    await pipeline([
      ["INCR", failKey],
      ["EXPIRE", failKey, 900],
    ]);
    return json(401, { error: "Wrong password." });
  }

  await redis(["DEL", failKey]);
  return json(200, { token: makeToken() });
}

async function pull() {
  const [chatsFlat, deletedFlat] = await pipeline([
    ["HGETALL", CHATS_KEY],
    ["HGETALL", DELETED_KEY],
  ]);

  const chats = [];
  for (let i = 1; i < (chatsFlat || []).length; i += 2) {
    try {
      chats.push(JSON.parse(chatsFlat[i]));
    } catch {}
  }
  const deleted = {};
  for (let i = 0; i < (deletedFlat || []).length; i += 2) deleted[deletedFlat[i]] = Number(deletedFlat[i + 1]);

  chats.sort((a, b) => b.updated - a.updated);
  return json(200, { chats, deleted });
}

async function push(request) {
  const body = await request.json().catch(() => null);
  if (!body) return json(400, { error: "Invalid request." });

  const upserts = (Array.isArray(body.upsert) ? body.upsert : []).slice(0, MAX_BATCH).map(cleanChat).filter(Boolean);
  const deletes = (Array.isArray(body.delete) ? body.delete : [])
    .slice(0, MAX_BATCH)
    .filter((d) => typeof d?.id === "string" && ID_RE.test(d.id) && Number.isFinite(d.at));

  const ids = [...new Set([...upserts.map((c) => c.id), ...deletes.map((d) => d.id)])];
  const commands = [];
  const accepted = [];

  if (ids.length) {
    const [existing, tombstones, count] = await pipeline([
      ["HMGET", CHATS_KEY, ...ids],
      ["HMGET", DELETED_KEY, ...ids],
      ["HLEN", CHATS_KEY],
    ]);
    const stored = Object.fromEntries(
      ids.map((id, i) => {
        try {
          return [id, existing[i] ? JSON.parse(existing[i]).updated : 0];
        } catch {
          return [id, 0];
        }
      })
    );
    const deletedAt = Object.fromEntries(ids.map((id, i) => [id, Number(tombstones[i] || 0)]));
    let total = Number(count || 0);

    for (const d of deletes) {
      commands.push(["HDEL", CHATS_KEY, d.id], ["HSET", DELETED_KEY, d.id, String(Math.max(d.at, deletedAt[d.id]))]);
      deletedAt[d.id] = Math.max(d.at, deletedAt[d.id]);
      if (stored[d.id]) total--;
      stored[d.id] = 0;
    }

    for (const chat of upserts) {
      // Newest version wins; a chat deleted after this version was saved stays deleted.
      if (chat.updated < stored[chat.id] || chat.updated <= deletedAt[chat.id]) continue;
      if (!stored[chat.id] && total >= MAX_CHATS) continue;
      if (!stored[chat.id]) total++;
      commands.push(["HSET", CHATS_KEY, chat.id, JSON.stringify(chat)]);
      if (deletedAt[chat.id]) commands.push(["HDEL", DELETED_KEY, chat.id]);
      accepted.push(chat.id);
    }
  }

  await pipeline(commands);
  return json(200, { ok: true, accepted });
}

async function handle(request, method) {
  if (!redisConfigured) return json(503, { error: "Sync storage isn't connected yet." });
  const action = new URL(request.url).searchParams.get("action");

  try {
    if (method === "POST" && action === "login") return await login(request);
    if (!process.env.OWNER_PASSWORD) return json(500, { error: "Sync isn't set up yet (no OWNER_PASSWORD)." });
    if (!isOwner(request)) return json(401, { error: "Please sign in again." });
    if (method === "GET") return await pull();
    if (method === "POST") return await push(request);
    return json(405, { error: "Method not allowed." });
  } catch (err) {
    console.error("sync error:", err?.message);
    return json(502, { error: "Sync storage had a problem. Your chats are still saved on this device." });
  }
}

export const GET = (request) => handle(request, "GET");
export const POST = (request) => handle(request, "POST");
