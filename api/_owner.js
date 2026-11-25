// Owner sign-in shared by the sync, Google and chat endpoints.
// A signed session token ("owner.<expiry>.<signature>") is issued by POST /api/sync?action=login
// and sent back as "Authorization: Bearer <token>". Only someone who knows OWNER_PASSWORD gets one.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_DAYS = 180;

const secret = () => `${process.env.SYNC_SECRET || ""}|${process.env.OWNER_PASSWORD || ""}`;
const sign = (payload) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `owner.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function sameText(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** True only for a valid, unexpired owner token (and only when OWNER_PASSWORD is configured). */
export function isOwner(request) {
  if (!process.env.OWNER_PASSWORD) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "owner") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return sameText(parts[2], sign(`${parts[0]}.${parts[1]}`));
}
