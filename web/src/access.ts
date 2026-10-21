// The admin page and its API sit behind Cloudflare Access, which signs the admin in (a code sent
// to their email, or Google) before a request reaches this Worker and adds a signed JWT saying who
// it is. The Worker checks that JWT itself and the email against ADMIN_EMAILS, so a gap in the
// Access setup doesn't open the admin page. Without ACCESS_TEAM_DOMAIN and ACCESS_AUD, nobody gets in.
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Env } from "./env";
import { ApiError, fromBase64url, utf8 } from "./util";

interface Jwk extends JsonWebKey {
  kid?: string;
}

const HOUR = 3600_000;
const certs = new Map<string, { fetched: number; keys: Promise<Jwk[]> }>();

/** The team's signing keys, kept an hour. Access rotates them every few weeks. */
function accessKeys(team: string, fresh = false): Promise<Jwk[]> {
  const cached = certs.get(team);
  if (cached && !fresh && Date.now() - cached.fetched < HOUR) return cached.keys;
  const keys = fetch(`https://${team}/cdn-cgi/access/certs`).then(async (response) => {
    if (!response.ok) throw new Error(`Access certs answered ${response.status}`);
    return ((await response.json()) as { keys?: Jwk[] }).keys ?? [];
  });
  certs.set(team, { fetched: Date.now(), keys });
  keys.catch(() => certs.delete(team));
  return keys;
}

/** `urbudget`, `urbudget.cloudflareaccess.com` or `https://urbudget.cloudflareaccess.com/` all name one team. */
export function teamDomain(value: string): string {
  const host = value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host.includes(".") ? host : `${host}.cloudflareaccess.com`;
}

const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64url(part))) as Record<string, unknown>;

/** The email in a valid Access token for this application, or null. */
export async function verifyAccessToken(env: Env, token: string, at = Date.now()): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const team = teamDomain(env.ACCESS_TEAM_DOMAIN);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decode(parts[0]);
    payload = decode(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const byKid = (keys: Jwk[]) => keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  // A token signed with a key we haven't seen means the cached list predates a rotation.
  const jwk = byKid(await accessKeys(team)) ?? byKid(await accessKeys(team, true));
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(parts[2]), utf8(`${parts[0]}.${parts[1]}`));
  if (!valid) return null;
  const seconds = at / 1000;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== `https://${team}` || !audiences.includes(env.ACCESS_AUD)) return null;
  // A minute of leeway for clocks.
  if (typeof payload.exp !== "number" || payload.exp < seconds - 60) return null;
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) return null;
  return typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;
}

const isLocal = (url: string) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
/**
 * `npm run dev` with .dev.vars: sign-in codes shown and a localhost APP_URL, never both in
 * production. (The request's own URL can't tell: wrangler dev rewrites it to the route's host.)
 */
const localDevelopment = (env: Env) => env.DEV_LOGIN_CODES === "1" && isLocal(env.APP_URL);

/** Who is making this request, if they're an admin: Access vouched for the email and ADMIN_EMAILS lists it. */
export async function adminFor(env: Env, request: Request): Promise<string | null> {
  // Local development has no Access in front of it, so there the admin page is open.
  if (localDevelopment(env)) return "dev@localhost";
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  let email: string | null;
  try {
    email = await verifyAccessToken(env, token);
  } catch (error) {
    console.error("[access]", error);
    throw new ApiError(503, "access_unavailable", "Cloudflare Access couldn't be reached to check the sign-in. Try again.");
  }
  const allowed = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return email && allowed.includes(email) ? email : null;
}

/** For the admin API. Changes must come from the admin page itself (the browser's Origin header). */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const admin = await adminFor(c.env, c.req.raw);
  if (!admin) throw new ApiError(403, "not_admin", "This needs an admin signed in through Cloudflare Access.");
  const origin = c.req.header("Origin") ?? "";
  const ownPage = origin === new URL(c.req.url).origin || (localDevelopment(c.env) && isLocal(origin));
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !ownPage)
    throw new ApiError(403, "bad_origin", "Admin changes must come from the admin page.");
  c.set("admin", admin);
  await next();
};
