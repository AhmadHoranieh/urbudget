// Authenticated Pub/Sub push notifications trigger a Google API refresh of known receipts.
// Notification types, event times and client-supplied product states never grant access.
import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { ApiError, fromBase64url, utf8 } from "../util";
import { PLAY_PACKAGE, refreshGooglePurchaseToken } from "./google";

type GoogleKey = JsonWebKey & { kid?: string };
let keyCache: { at: number; until: number; keys: Promise<GoogleKey[]> } | undefined;
const unavailable = () => new ApiError(503, "notification_unavailable", "Notification verification is temporarily unavailable.");
const invalid = () => new ApiError(400, "invalid_notification", "Invalid purchase notification.");

async function signingKeys(force = false): Promise<GoogleKey[]> {
  const cached = keyCache;
  // A random kid must not make every unauthenticated request fetch Google's keys again.
  if (cached && cached.until > Date.now() && (!force || Date.now() - cached.at < 60_000)) return cached.keys;
  const entry = { at: Date.now(), until: Date.now() + 3600_000, keys: Promise.resolve([] as GoogleKey[]) };
  entry.keys = (async () => {
    try {
      const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw unavailable();
      const data = await response.json() as { keys?: GoogleKey[] };
      if (!Array.isArray(data.keys) || !data.keys.length || data.keys.length > 10) throw unavailable();
      const age = response.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1];
      entry.until = Date.now() + Math.min(3600, Math.max(60, Number(age ?? 3600))) * 1000;
      return data.keys;
    } catch { throw unavailable(); }
  })();
  keyCache = entry;
  entry.keys.catch(() => { if (keyCache === entry) keyCache = undefined; });
  return entry.keys;
}

const decode = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};

export async function verifyGooglePushToken(env: Env, token: string, at = Date.now()): Promise<boolean> {
  if (!env.GOOGLE_PLAY_PUSH_EMAIL || !env.GOOGLE_PLAY_PUSH_AUDIENCE || token.length > 8192) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try { header = decode(parts[0]); claims = decode(parts[1]); } catch { return false; }
  const seconds = at / 1000;
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 200 ||
      !["https://accounts.google.com", "accounts.google.com"].includes(String(claims.iss)) ||
      claims.aud !== env.GOOGLE_PLAY_PUSH_AUDIENCE || claims.email !== env.GOOGLE_PLAY_PUSH_EMAIL || claims.email_verified !== true ||
      typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= seconds ||
      typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 || claims.iat < seconds - 7200 ||
      claims.exp - claims.iat > 7200 || (typeof claims.nbf === "number" && claims.nbf > seconds + 60)) return false;
  const byKid = (keys: GoogleKey[]) => keys.find(key => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256"));
  const jwk = byKid(await signingKeys()) ?? byKid(await signingKeys(true));
  if (!jwk) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(parts[2]), utf8(`${parts[0]}.${parts[1]}`));
  } catch { return false; }
}

async function notificationBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 32_768) { await reader.cancel(); throw new ApiError(413, "too_large", "Notification is too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const envelope = JSON.parse(new TextDecoder().decode(bytes)) as { message?: { data?: unknown } };
    const data = envelope?.message?.data;
    if (typeof data !== "string" || data.length > 24_000 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) throw invalid();
    return decode(data);
  } catch { throw invalid(); }
}

export const googleNotifications = new Hono<AppEnv>();
googleNotifications.post("/", async (c) => {
  if (!c.env.GOOGLE_PLAY_PUSH_EMAIL || !c.env.GOOGLE_PLAY_PUSH_AUDIENCE) throw unavailable();
  const authorization = c.req.header("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !(await verifyGooglePushToken(c.env, authorization.slice(7))))
    throw new ApiError(401, "invalid_push_token", "Google push authentication is required.");
  const data = await notificationBody(c.req.raw);
  if (data.packageName !== PLAY_PACKAGE) throw invalid();
  if (data.testNotification && typeof data.testNotification === "object") return c.body(null, 204);
  const notices = [data.subscriptionNotification, data.oneTimeProductNotification, data.voidedPurchaseNotification]
    .filter(value => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown>[];
  if (notices.length !== 1) throw invalid();
  const token = notices[0].purchaseToken;
  if (typeof token !== "string" || token.length < 8 || token.length > 4096) throw invalid();
  // A transient provider failure returns 503 so Pub/Sub retries. Duplicate and out-of-order
  // deliveries are safe: the latest Google state is fetched instead of replaying event state.
  await refreshGooglePurchaseToken(c.env, token);
  return c.body(null, 204);
});
