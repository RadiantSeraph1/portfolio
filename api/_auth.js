// Owner sign-in shared by /api/sync, /api/chat (Claude) and /api/dashboard.
//
// A session token looks like "owner.<expiry-ms>.<signature>", signed with OWNER_PASSWORD
// (and the optional SYNC_SECRET), so changing either signs out every device.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_DAYS = 180;

const secret = () => `${process.env.SYNC_SECRET || ""}|${process.env.OWNER_PASSWORD || ""}`;
const sign = (payload) => createHmac("sha256", secret()).update(payload).digest("base64url");

export const ownerConfigured = () => Boolean(process.env.OWNER_PASSWORD);

export function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `owner.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** Compare two strings in constant time. */
export function sameText(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** True when the request carries a valid, unexpired owner token. */
export function isOwner(request) {
  if (!ownerConfigured()) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "owner") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return sameText(parts[2], sign(`${parts[0]}.${parts[1]}`));
}
