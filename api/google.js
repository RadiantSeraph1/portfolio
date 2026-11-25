// Owner-only Google Drive connection for the AI chat.
//   GET  /api/google?action=status      -> { configured, connected, email }
//   POST /api/google?action=connect     -> { url }  (the page then sends the browser to Google)
//   GET  /api/google?action=callback    <- Google redirects here after the owner approves
//   POST /api/google?action=disconnect  -> revokes access and forgets the token
// Everything except the callback needs the owner's sign-in token. The callback is protected by a
// one-time "state" value that only a signed-in owner can create.

import { randomBytes } from "node:crypto";
import { redis, redisConfigured } from "./_redis.js";
import { isOwner } from "./_owner.js";
import { authUrl, exchangeCode, saveConnection, revoke, connectionStatus, googleConfigured } from "./_google.js";

const STATE_TTL_SECONDS = 600;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function redirectUri(request) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host;
  return `https://${host}/api/google?action=callback`;
}

function back(result, reason = "") {
  const params = new URLSearchParams({ google: result });
  if (reason) params.set("reason", reason.slice(0, 120));
  return new Response(null, { status: 302, headers: { location: `/ai/?${params}`, "cache-control": "no-store" } });
}

async function callback(request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  if (url.searchParams.get("error")) return back("error", "Google access was not granted.");
  if (!/^[\w-]{20,64}$/.test(state)) return back("error", "Invalid sign-in link.");

  const key = `google:state:${state}`;
  const known = await redis(["GET", key]);
  await redis(["DEL", key]);
  if (!known) return back("error", "That connect link expired. Try again.");

  try {
    const tokens = await exchangeCode({ code: url.searchParams.get("code") || "", redirectUri: redirectUri(request) });
    await saveConnection(tokens);
    return back("connected");
  } catch (err) {
    console.warn("google callback failed:", err?.message);
    return back("error", err?.message || "Could not connect to Google.");
  }
}

async function handle(request, method) {
  const action = new URL(request.url).searchParams.get("action");
  if (!googleConfigured()) return json(200, { configured: false, connected: false });
  if (!redisConfigured) return json(503, { error: "Storage isn't connected yet." });

  try {
    if (method === "GET" && action === "callback") return await callback(request);

    if (!isOwner(request)) return json(401, { error: "Please sign in again." });

    if (method === "GET" && action === "status") return json(200, await connectionStatus());

    if (method === "POST" && action === "connect") {
      const state = randomBytes(24).toString("base64url");
      await redis(["SET", `google:state:${state}`, "1", "EX", String(STATE_TTL_SECONDS)]);
      return json(200, { url: authUrl({ redirectUri: redirectUri(request), state }) });
    }

    if (method === "POST" && action === "disconnect") {
      await revoke();
      return json(200, { configured: true, connected: false });
    }
    return json(400, { error: "Unknown action." });
  } catch (err) {
    console.error("google endpoint error:", err?.message);
    return json(502, { error: "Something went wrong talking to Google or storage. Please try again." });
  }
}

export const GET = (request) => handle(request, "GET");
export const POST = (request) => handle(request, "POST");
