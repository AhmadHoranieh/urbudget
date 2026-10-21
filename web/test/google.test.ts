import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { PLAY_SYNC, subscriptionEntitlement, verifyGooglePurchase, refreshGooglePurchases } from "../src/billing/google";
import { syncActive } from "../src/sync";
import { cancelSubscriptions } from "../src/billing";
import { createSession } from "../src/auth";
import { base64url, sha256 } from "../src/util";
import { testEnv, type TestEnv } from "./fakes";

let env: TestEnv;
let privateKey: string;
let provider: Record<string, unknown>;
let calls: { url: string; method: string; body?: unknown }[];
const user = { id: "usr_play", email: "play@example.com" };
const token = "verified-purchase-token";
let accountId: string;
let ackFails = false;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  privateKey = base64url(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  accountId = await sha256(`urbudget:${user.id}`);
});
const subscription = (state = "SUBSCRIPTION_STATE_ACTIVE", expiry = Date.now() + 86400000) => ({
  externalAccountIdentifiers: { obfuscatedExternalAccountId: accountId }, subscriptionState: state,
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
  lineItems: [{ productId: PLAY_SYNC, expiryTime: new Date(expiry).toISOString(), autoRenewingPlan: { autoRenewEnabled: state !== "SUBSCRIPTION_STATE_CANCELED" } }],
});
beforeEach(async () => {
  env = await testEnv();
  env.GOOGLE_PLAY_SERVICE_ACCOUNT = JSON.stringify({ client_email: "test@billing.iam.gserviceaccount.com", private_key: privateKey });
  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?1, ?2, ?3)").bind(user.id, user.email, new Date().toISOString()).run();
  provider = subscription(); calls = []; ackFails = false;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body && !url.includes("oauth2") ? JSON.parse(String(init.body)) : undefined });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "test-access", expires_in: 3600 });
    if (url.endsWith(":acknowledge")) return ackFails ? new Response("unavailable", { status: 503 }) : new Response(null, { status: 204 });
    if (url.endsWith(":cancel")) return new Response(null, { status: 204 });
    if (method === "GET" && url.startsWith("https://androidpublisher.googleapis.com/")) return Response.json(provider);
    throw new Error("Unexpected external request");
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const sync = () => syncActive(env.DB, user.id);
const subscriptionStatus = async () => env.DB.prepare("SELECT status FROM subscriptions WHERE id = ?1").bind(`google:${await sha256(token)}`).first("status");

describe("Google purchase verification", () => {
  it("grants sync once, then acknowledges; retries do not duplicate it", async () => {
    const first = await verifyGooglePurchase(env, user, token);
    expect(first).toEqual({ active: true, pending: false });
    await verifyGooglePurchase(env, user, token);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first("n")).toBe(1);
    expect(await sync()).toBe(true);
    expect(calls.filter(c => c.url.endsWith(":acknowledge"))).toHaveLength(2);
    expect(calls.find(c => c.url.endsWith(":acknowledge"))?.url).toContain(`/subscriptions/${PLAY_SYNC}/tokens/`);
    expect(await env.DB.prepare("SELECT acknowledged FROM google_purchases").first("acknowledged")).toBe(1);
  });
  it.each(["SUBSCRIPTION_STATE_PENDING", "SUBSCRIPTION_STATE_EXPIRED"])("never grants or acknowledges %s", async state => {
    provider = subscription(state, 0);
    expect(await verifyGooglePurchase(env, user, token)).toEqual({ active: false, pending: state === "SUBSCRIPTION_STATE_PENDING" });
    expect(await env.DB.prepare("SELECT state FROM google_purchases").first("state")).toBe(state);
    expect(await sync()).toBe(false);
    expect(calls.some(c => c.url.endsWith(":acknowledge"))).toBe(false);
  });
  it("rejects another account even on the first claim", async () => {
    provider.externalAccountIdentifiers = { obfuscatedExternalAccountId: "someone-else" };
    await expect(verifyGooglePurchase(env, user, token)).rejects.toMatchObject({ code: "invalid_purchase" });
  });
  it("does not rebind an existing token", async () => {
    await verifyGooglePurchase(env, user, token);
    await expect(verifyGooglePurchase(env, { id: "other" }, token)).rejects.toMatchObject({ code: "invalid_purchase" });
  });
  it("rejects a mismatched Google product", async () => {
    provider.lineItems = [{ productId: "unrelated", expiryTime: new Date(Date.now() + 86400000).toISOString() }];
    await expect(verifyGooglePurchase(env, user, token)).rejects.toMatchObject({ code: "invalid_purchase" });
  });
  it("keeps a durable entitlement when acknowledgement fails, and retries safely", async () => {
    ackFails = true;
    await expect(verifyGooglePurchase(env, user, token)).rejects.toMatchObject({ code: "play_unavailable" });
    expect(await sync()).toBe(true);
    ackFails = false;
    await verifyGooglePurchase(env, user, token);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT acknowledged FROM google_purchases").first("acknowledged")).toBe(1);
  });
  it("accepts an empty successful acknowledgement response", async () => {
    const fetcher = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => String(input).endsWith(":acknowledge")
      ? new Response(null, { status: 200 }) : fetcher(input, init));
    expect((await verifyGooglePurchase(env, user, token)).active).toBe(true);
    expect(await env.DB.prepare("SELECT acknowledged FROM google_purchases").first("acknowledged")).toBe(1);
  });
  it("ends sync on refresh once Google says the subscription expired", async () => {
    await verifyGooglePurchase(env, user, token);
    provider = subscription("SUBSCRIPTION_STATE_EXPIRED", 0);
    await env.DB.prepare("UPDATE google_purchases SET checked_at = '2000-01-01'").run();
    await refreshGooglePurchases(env, user.id);
    expect(await subscriptionStatus()).toBe("canceled");
    expect(await sync()).toBe(false);
  });
  it("finishes a stored pending payment on refresh without granting early", async () => {
    provider = subscription("SUBSCRIPTION_STATE_PENDING", 0);
    expect((await verifyGooglePurchase(env, user, token)).pending).toBe(true);
    expect(await sync()).toBe(false);
    provider = subscription();
    await refreshGooglePurchases(env, user.id, true);
    expect(await sync()).toBe(true);
    expect(calls.filter(c => c.url.endsWith(":acknowledge"))).toHaveLength(1);
  });
  it("offers only Sync: no lifetime product in the context, and its receipts are refused", async () => {
    const session = await createSession(env.DB, user.id, "desktop", null);
    const headers = { Authorization: `Bearer ${session}`, "Content-Type": "application/json" };
    const context = await app.request("/api/v1/billing/google/context", { headers }, env);
    expect(await context.json()).toEqual({ accountId, syncId: PLAY_SYNC, basePlanId: "monthly" });
    const lifetime = await app.request("/api/v1/billing/google/verify", { method: "POST", headers, body: JSON.stringify({ token, products: ["urbudget_lifetime"] }) }, env);
    expect(lifetime.status).toBe(400);
    expect(await lifetime.json()).toMatchObject({ error: "invalid_purchase" });
    expect(calls.some(c => c.url.includes("androidpublisher"))).toBe(false);
    const verified = await app.request("/api/v1/billing/google/verify", { method: "POST", headers, body: JSON.stringify({ token, products: [PLAY_SYNC] }) }, env);
    expect(await verified.json()).toEqual({ active: true, pending: false });
  });
  it("keeps checking a receipt after the account was deleted without recreating it", async () => {
    await verifyGooglePurchase(env, user, token);
    await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(user.id).run();
    provider = subscription("SUBSCRIPTION_STATE_EXPIRED", 0);
    await refreshGooglePurchases(env, undefined, true);
    expect(await env.DB.prepare("SELECT state FROM google_purchases").first("state")).toBe("SUBSCRIPTION_STATE_EXPIRED");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT user_id FROM google_purchases").first("user_id")).toBeNull();
  });
  it.each([
    ["before verification", false], ["during provider read", false],
    ["before verification", true], ["during provider read", true],
  ] as const)("keeps provider truth when deletion occurs %s (expired=%s)", async (stage, expired) => {
    await verifyGooglePurchase(env, user, token);
    const session = await createSession(env.DB, user.id, "desktop", null);
    provider = expired ? subscription("SUBSCRIPTION_STATE_EXPIRED", 0) : subscription();
    let entered!: () => void, resume!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { resume = resolve; });
    let pause = true;
    if (stage === "before verification") {
      const prepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        const original = prepare(sql);
        if (sql !== "SELECT * FROM google_purchases WHERE token_hash = ?1") return original;
        const bind = original.bind.bind(original);
        original.bind = (...args) => {
          const statement = bind(...args);
          const first = statement.first.bind(statement);
          statement.first = async (...args) => {
            if (pause) { pause = false; entered(); await released; }
            return first(...args);
          };
          return statement;
        };
        return original;
      };
    } else {
      const fetcher = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        if (pause && String(input).includes("subscriptionsv2/tokens/")) {
          pause = false; entered(); await released;
        }
        return fetcher(input, init);
      });
    }
    const refresh = refreshGooglePurchases(env, undefined, true);
    await paused;
    const deleted = await app.request("/api/v1/me", { method: "DELETE", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: user.email }) }, env);
    expect(deleted.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
    resume();
    await refresh;
    expect(await env.DB.prepare("SELECT state FROM google_purchases").first("state"))
      .toBe(expired ? "SUBSCRIPTION_STATE_EXPIRED" : "SUBSCRIPTION_STATE_ACTIVE");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT user_id FROM google_purchases").first("user_id")).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id IS NOT NULL").first("n")).toBe(0);
  });
  it("sanitizes network failures without leaking the purchase token", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error(`Failed URL containing ${token}`); });
    await expect(verifyGooglePurchase(env, user, token)).rejects.toMatchObject({ code: "play_unavailable" });
    await expect(verifyGooglePurchase(env, user, token)).rejects.not.toThrow(token);
  });
  it("does not end sync on a temporary Google failure", async () => {
    await verifyGooglePurchase(env, user, token);
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    await refreshGooglePurchases(env, user.id, true);
    expect(await subscriptionStatus()).toBe("active");
    expect(await sync()).toBe(true);
  });
  it("revokes a previously verified token when Google says it no longer exists", async () => {
    await verifyGooglePurchase(env, user, token);
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 410 }));
    await refreshGooglePurchases(env, user.id, true);
    expect(await env.DB.prepare("SELECT state FROM google_purchases").first("state")).toBe("UNAVAILABLE");
    expect(await sync()).toBe(false);
  });
  it("grants sync and denies it at expiry even without another provider refresh", async () => {
    provider = subscription();
    await verifyGooglePurchase(env, user, token);
    expect(await syncActive(env.DB, user.id)).toBe(true);
    await env.DB.prepare("UPDATE subscriptions SET current_period_end = '2000-01-01'").run();
    expect(await syncActive(env.DB, user.id)).toBe(false);
  });
  it("keeps access through a cancelled subscription's paid period", () => {
    expect(subscriptionEntitlement(subscription("SUBSCRIPTION_STATE_CANCELED"), accountId).active).toBe(true);
  });
  it("keeps the existing subscription while its linked replacement is pending", async () => {
    provider = subscription();
    await verifyGooglePurchase(env, user, token);
    provider = { ...subscription("SUBSCRIPTION_STATE_PENDING"), linkedPurchaseToken: token };
    expect((await verifyGooglePurchase(env, user, "pending-replacement-token")).pending).toBe(true);
    expect(await syncActive(env.DB, user.id)).toBe(true);
    expect(await env.DB.prepare("SELECT status FROM subscriptions WHERE id = ?1").bind(`google:${await sha256(token)}`).first("status")).toBe("active");
  });
  it.each(["SUBSCRIPTION_STATE_ON_HOLD", "SUBSCRIPTION_STATE_PAUSED", "SUBSCRIPTION_STATE_EXPIRED", "SUBSCRIPTION_STATE_PENDING"])("denies sync in %s", state => {
    expect(subscriptionEntitlement(subscription(state), accountId).active).toBe(false);
  });
  it("keeps grace-period access only through verified expiry", () => {
    expect(subscriptionEntitlement(subscription("SUBSCRIPTION_STATE_IN_GRACE_PERIOD"), accountId).active).toBe(true);
    expect(subscriptionEntitlement(subscription("SUBSCRIPTION_STATE_IN_GRACE_PERIOD", 0), accountId).active).toBe(false);
  });
  it("cancels Google renewals on deletion without sending their ID to Polar", async () => {
    provider = subscription();
    await verifyGooglePurchase(env, user, token);
    await cancelSubscriptions(env, user.id);
    expect(calls.find(c => c.url.endsWith(":cancel"))?.body).toEqual({ cancellationContext: { cancellationType: "DEVELOPER_REQUESTED_STOP_PAYMENTS" } });
    expect(calls.some(c => c.url.includes("polar"))).toBe(false);
  });
  it("does not recancel an already canceled Google subscription on account deletion", async () => {
    provider = subscription("SUBSCRIPTION_STATE_CANCELED");
    await verifyGooglePurchase(env, user, token);
    await cancelSubscriptions(env, user.id);
    expect(calls.some(c => c.url.endsWith(":cancel"))).toBe(false);
  });
  it.each(["SUBSCRIPTION_STATE_PAUSED", "SUBSCRIPTION_STATE_ON_HOLD", "SUBSCRIPTION_STATE_PENDING"])("stops %s before deletion even without a future expiry", async state => {
    provider = subscription(state, 0);
    if (state === "SUBSCRIPTION_STATE_PENDING") {
      provider.lineItems = [{ productId: PLAY_SYNC, autoRenewingPlan: { autoRenewEnabled: true } }];
    }
    await verifyGooglePurchase(env, user, token);
    calls = [];
    await cancelSubscriptions(env, user.id);
    expect(calls.some(c => c.url.includes("subscriptionsv2") && c.method === "GET")).toBe(true);
    expect(calls.find(c => c.url.endsWith(":cancel"))?.body).toEqual({ cancellationContext: { cancellationType: "DEVELOPER_REQUESTED_STOP_PAYMENTS" } });
  });
  it("refreshes stale expired/canceled state before skipping a resumed subscription", async () => {
    provider = subscription("SUBSCRIPTION_STATE_EXPIRED", 0);
    await verifyGooglePurchase(env, user, token);
    provider = subscription(); calls = [];
    await cancelSubscriptions(env, user.id);
    expect(calls.some(c => c.url.endsWith(":cancel"))).toBe(true);
  });
  it("uses current terminal state to avoid failing cancellation of a now-expired receipt", async () => {
    provider = subscription();
    await verifyGooglePurchase(env, user, token);
    provider = subscription("SUBSCRIPTION_STATE_EXPIRED", 0); calls = [];
    await cancelSubscriptions(env, user.id);
    expect(calls.some(c => c.url.endsWith(":cancel"))).toBe(false);
  });
  it("keeps the account when Google cannot stop an awaiting-payment purchase", async () => {
    provider = subscription("SUBSCRIPTION_STATE_PENDING", 0);
    await verifyGooglePurchase(env, user, token);
    const session = await createSession(env.DB, user.id, "desktop", null);
    const fetcher = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => String(input).endsWith(":cancel")
      ? new Response("cannot cancel pending", { status: 400 }) : fetcher(input, init));
    const response = await app.request("/api/v1/me", { method: "DELETE", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: user.email }) }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "play_cancel_failed" });
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(user.id).first("id")).toBe(user.id);
    expect(await env.DB.prepare("SELECT user_id FROM google_purchases").first("user_id")).toBe(user.id);
  });
  it.each(["before receipt persistence", "before subscription grant"])("does not grant or acknowledge a purchase crossing deletion %s", async (stage) => {
    provider = subscription();
    await verifyGooglePurchase(env, user, token);
    const session = await createSession(env.DB, user.id, "desktop", null);
    const newToken = "new-recurring-purchase";
    let purchaseEntered!: () => void, purchaseResume!: () => void;
    let cancellationEntered!: () => void, cancellationResume!: () => void;
    const purchasePaused = new Promise<void>((resolve) => { purchaseEntered = resolve; });
    const purchaseReleased = new Promise<void>((resolve) => { purchaseResume = resolve; });
    const cancellationPaused = new Promise<void>((resolve) => { cancellationEntered = resolve; });
    const cancellationReleased = new Promise<void>((resolve) => { cancellationResume = resolve; });
    let purchaseGate = true, cancellationGate = true;
    const fetcher = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (stage === "before receipt persistence" && purchaseGate && url.endsWith(`/tokens/${newToken}`)) {
        purchaseGate = false; purchaseEntered(); await purchaseReleased;
      }
      if (cancellationGate && url.endsWith(":cancel")) {
        cancellationGate = false; cancellationEntered(); await cancellationReleased;
      }
      return fetcher(input, init);
    });
    if (stage === "before subscription grant") {
      const prepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        const original = prepare(sql);
        if (!sql.includes("INSERT INTO subscriptions")) return original;
        const bind = original.bind.bind(original);
        original.bind = (...args) => {
          const statement = bind(...args);
          const run = statement.run.bind(statement);
          statement.run = async () => {
            if (purchaseGate) { purchaseGate = false; purchaseEntered(); await purchaseReleased; }
            return run();
          };
          return statement;
        };
        return original;
      };
    }
    const purchase = verifyGooglePurchase(env, user, newToken).catch((error: unknown) => error);
    await purchasePaused;
    const deletion = app.request("/api/v1/me", { method: "DELETE", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: user.email }) }, env);
    await cancellationPaused;
    purchaseResume();
    expect(await purchase).toMatchObject({ code: "invalid_purchase" });
    expect(calls.some((c) => c.url.endsWith(`/tokens/${newToken}:acknowledge`))).toBe(false);
    expect(await env.DB.prepare("SELECT 1 FROM subscriptions WHERE id = ?1").bind(`google:${await sha256(newToken)}`).first()).toBeNull();
    cancellationResume();
    expect((await deletion).status).toBe(200);
    expect(calls.some((c) => c.url.endsWith(`/tokens/${newToken}:cancel`))).toBe(stage === "before subscription grant");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
  });
  it("rejects unknown and multi-product entitlements", () => {
    expect(() => subscriptionEntitlement({}, accountId)).toThrow();
    expect(() => subscriptionEntitlement({ ...subscription(), lineItems: [{ productId: "urbudget_lifetime" }] }, accountId)).toThrow();
    expect(() => subscriptionEntitlement({ ...subscription(), lineItems: [{ productId: PLAY_SYNC }, { productId: PLAY_SYNC }] }, accountId)).toThrow();
  });
  it("requires authentication and configured server credentials", async () => {
    const response = await app.request("/api/v1/billing/google/verify", { method: "POST", body: JSON.stringify({ token, products: [PLAY_SYNC] }) }, env);
    expect(response.status).toBe(401);
    env.GOOGLE_PLAY_SERVICE_ACCOUNT = undefined;
    await expect(verifyGooglePurchase(env, user, token)).rejects.toMatchObject({ code: "play_unavailable" });
  });
});
