import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { PLAY_PACKAGE, PLAY_SYNC, verifyGooglePurchase } from "../src/billing/google";
import { verifyGooglePushToken } from "../src/billing/google-rtdn";
import { syncActive } from "../src/sync";
import { base64url, sha256, utf8 } from "../src/util";
import { testEnv, type TestEnv } from "./fakes";

let pair: CryptoKeyPair;
let jwk: JsonWebKey;
let pem: string;
let env: TestEnv;
let provider: Record<string, unknown>;
let calls: string[];
let apiStatus = 200;
const user = { id: "usr_push", email: "push@example.com" };
const purchaseToken = "notification-purchase-token";
const endpoint = "/api/v1/billing/google/notifications";
const pushEmail = "push@billing.iam.gserviceaccount.com";
const pushAudience = "https://urbudget.app/api/v1/billing/google/notifications";

beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  pem = base64url(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
});
beforeEach(async () => {
  env = await testEnv();
  env.GOOGLE_PLAY_SERVICE_ACCOUNT = JSON.stringify({ client_email: "test@billing.iam.gserviceaccount.com", private_key: pem });
  env.GOOGLE_PLAY_PUSH_EMAIL = pushEmail;
  env.GOOGLE_PLAY_PUSH_AUDIENCE = pushAudience;
  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?1, ?2, ?3)").bind(user.id, user.email, new Date().toISOString()).run();
  provider = await subscription();
  calls = []; apiStatus = 200;
  vi.stubGlobal("fetch", async (input: string) => {
    const url = String(input); calls.push(url);
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [{ ...jwk, kid: "push-test-key" }] });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fake", expires_in: 3600 });
    if (url.endsWith(":acknowledge")) return new Response(null, { status: 204 });
    if (url.startsWith("https://androidpublisher.googleapis.com/")) return apiStatus === 200 ? Response.json(provider) : new Response("provider error", { status: apiStatus });
    throw new Error("Unexpected network request");
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function subscription(state = "SUBSCRIPTION_STATE_ACTIVE", expiry = Date.now() + 86_400_000) {
  return {
    externalAccountIdentifiers: { obfuscatedExternalAccountId: await sha256(`urbudget:${user.id}`) }, subscriptionState: state,
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    lineItems: [{ productId: PLAY_SYNC, expiryTime: new Date(expiry).toISOString(), autoRenewingPlan: { autoRenewEnabled: true } }],
  };
}
const status = () => env.DB.prepare("SELECT status FROM subscriptions").first("status");

async function jwt(changes: Record<string, unknown> = {}, headerChanges: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${base64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "push-test-key", ...headerChanges })))}.${base64url(utf8(JSON.stringify({
    iss: "https://accounts.google.com", sub: "123456789", email: pushEmail, email_verified: true,
    aud: pushAudience, iat: now, exp: now + 3600, ...changes,
  })))}`;
  return `${body}.${base64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, utf8(body)))}`;
}
const notice = (kind = "subscriptionNotification") => ({ packageName: PLAY_PACKAGE, [kind]: { purchaseToken, notificationType: 1 } });
async function push(data: unknown, auth?: string) {
  return app.request(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth ?? await jwt()}` },
    body: JSON.stringify({ message: { data: base64url(utf8(JSON.stringify(data))), messageId: "message-1" } }) }, env);
}

describe("authenticated Google Play notifications", () => {
  it("verifies Google's signature and exact configured identity", async () => {
    expect(await verifyGooglePushToken(env, await jwt())).toBe(true);
    expect(await verifyGooglePushToken(env, await jwt({ iss: "accounts.google.com" }))).toBe(true);
  });
  it.each([
    { iss: "https://attacker.example" }, { aud: "different-audience" }, { aud: [pushAudience] },
    { email: "other@billing.iam.gserviceaccount.com" }, { email_verified: false }, { email_verified: "true" },
    { exp: 1 }, { exp: "9999999999" }, { iat: 9999999999 }, { iat: 1 }, { sub: "" },
  ])("rejects correctly signed tokens with invalid claims: %j", async claims => {
    const response = await push(notice(), await jwt(claims));
    expect(response.status).toBe(401);
    expect(calls.some(url => url.includes("androidpublisher"))).toBe(false);
  });
  it("rejects a forged signature, unsupported algorithm and unknown signing key", async () => {
    const good = await jwt();
    expect(await verifyGooglePushToken(env, `${good.slice(0, good.lastIndexOf(".") + 1)}AAAA`)).toBe(false);
    expect(await verifyGooglePushToken(env, await jwt({}, { alg: "HS256" }))).toBe(false);
    expect(await verifyGooglePushToken(env, await jwt({}, { kid: "unknown" }))).toBe(false);
    expect(calls.filter(url => url.endsWith("/certs")).length).toBeLessThanOrEqual(1);
  });
  it("requires configuration and a Bearer token without an account session", async () => {
    expect((await app.request(endpoint, { method: "POST" }, env)).status).toBe(401);
    env.GOOGLE_PLAY_PUSH_EMAIL = undefined;
    expect((await push(notice())).status).toBe(503);
  });
  it("acknowledges test messages without touching purchase state", async () => {
    expect((await push({ packageName: PLAY_PACKAGE, testNotification: { version: "1.0" } })).status).toBe(204);
    expect(calls.some(url => url.includes("androidpublisher"))).toBe(false);
  });
  it("ignores unknown purchase tokens without granting access or querying Google", async () => {
    expect((await push(notice())).status).toBe(204);
    expect(calls.some(url => url.includes("androidpublisher"))).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first("n")).toBe(0);
  });
  it.each(["oneTimeProductNotification", "subscriptionNotification", "voidedPurchaseNotification"])("refreshes known receipts on %s using Google's current state", async kind => {
    await verifyGooglePurchase(env, user, purchaseToken);
    provider = await subscription("SUBSCRIPTION_STATE_EXPIRED", 0);
    calls = [];
    // Even a misleading 'purchased' type cannot grant: only the API response controls access.
    expect((await push(notice(kind))).status).toBe(204);
    expect(calls.some(url => url.includes("subscriptionsv2"))).toBe(true);
    expect(await status()).toBe("canceled");
    expect(await syncActive(env.DB, user.id)).toBe(false);
  });
  it("completes delayed payment and tolerates redelivery without duplicate subscriptions", async () => {
    provider = await subscription("SUBSCRIPTION_STATE_PENDING", 0);
    expect((await verifyGooglePurchase(env, user, purchaseToken)).pending).toBe(true);
    expect(await syncActive(env.DB, user.id)).toBe(false);
    provider = await subscription();
    expect((await push(notice())).status).toBe(204);
    expect((await push(notice())).status).toBe(204);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first("n")).toBe(1);
    expect(await syncActive(env.DB, user.id)).toBe(true);
  });
  it("returns a retryable error on temporary API failure and preserves access", async () => {
    await verifyGooglePurchase(env, user, purchaseToken); apiStatus = 503;
    const response = await push(notice());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(purchaseToken);
    expect(await status()).toBe("active");
  });
  it("revokes a missing receipt after an authenticated notification", async () => {
    await verifyGooglePurchase(env, user, purchaseToken); apiStatus = 410;
    expect((await push(notice())).status).toBe(204);
    expect(await status()).toBe("canceled");
  });
  it.each([{ packageName: "another.app", testNotification: {} }, { packageName: PLAY_PACKAGE }, { packageName: PLAY_PACKAGE, oneTimeProductNotification: { purchaseToken: "short" } }])("rejects malformed notification %j", async data => {
    expect((await push(data)).status).toBe(400);
  });
  it("bounds streamed request bytes before JSON parsing", async () => {
    const response = await app.request(endpoint, { method: "POST", headers: { Authorization: `Bearer ${await jwt()}`, "Content-Length": "1" }, body: "a".repeat(32_769) }, env);
    expect(response.status).toBe(413);
  });
});
