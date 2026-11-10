// Minimal Upstash Redis REST client (no dependencies).
// Works with the env vars created by the Vercel Upstash integration (KV_REST_API_*)
// or by the Upstash console (UPSTASH_REDIS_REST_*).

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redisConfigured = Boolean(URL_ && TOKEN);

/** Run one command, e.g. redis(["HGET", "key", "field"]). Returns the result or throws. */
export async function redis(command) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`redis ${command[0]} failed: ${data.error || res.status}`);
  return data.result;
}

/** Run several commands in one round trip. Returns an array of results (throws on any error). */
export async function pipeline(commands) {
  if (!commands.length) return [];
  const res = await fetch(`${URL_.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data)) throw new Error(`redis pipeline failed: ${res.status}`);
  const failed = data.find((r) => r?.error);
  if (failed) throw new Error(`redis pipeline failed: ${failed.error}`);
  return data.map((r) => r.result);
}
