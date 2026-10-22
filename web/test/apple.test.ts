import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { appleRoots, verifyAppleJws } from "../src/billing/apple-jws";
import { APP_STORE_APP_ID, APP_STORE_BUNDLE, APP_STORE_MANAGE_URL, APP_STORE_SYNC, appAccountToken, settleAppleSubscriptions } from "../src/billing/apple";
import { syncActive } from "../src/sync";
import { base64url, utf8 } from "../src/util";
import { APPLE_LEAF, appleLikeChain, certificate, signJws, type Chain } from "./apple-certs";
import { testEnv, type TestEnv } from "./fakes";

const DAY = 86_400_000;
let env: TestEnv;
let chain: Chain;
let calls: string[];
let ids = 1000;

beforeAll(async () => {
  chain = await appleLikeChain();
  appleRoots.add(chain.rootSha256);
});
afterAll(() => { appleRoots.delete(chain.rootSha256); });
beforeEach(async () => {
  env = await testEnv();
  calls = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (/\/v1\/subscriptions\/[\w-]+$/.test(String(url)) && init?.method === "DELETE") return Response.json({ id: "sub" });
    throw new Error("Unexpected external request");
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); env.DB.sqlite.close(); });

const json = (method: string, body: unknown, headers = {}) => ({ method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const call = (path: string, init: RequestInit = {}) => app.request(`/api/v1${path}`, init, env);
async function signIn(email = "iphone@example.com") {
  const start = await (await call("/auth/start", json("POST", { email }))).json() as { devCode: string };
  const verified = await (await call("/auth/verify", json("POST", { email, code: start.devCode, client: "desktop" }))).json() as { user: { id: string }; token: string };
  return { id: verified.user.id, email, token: await appAccountToken(verified.user.id), headers: { Authorization: `Bearer ${verified.token}` } };
}
type Account = Awaited<ReturnType<typeof signIn>>;

const ORIGINAL = "2000000000000001";
/** A StoreKit 2 transaction as Apple signs it, for the Sync subscription in Sandbox. */
const transaction = (overrides: Record<string, unknown> = {}) => ({
  transactionId: String(ids++), originalTransactionId: ORIGINAL, webOrderLineItemId: String(ids++),
  bundleId: APP_STORE_BUNDLE, productId: APP_STORE_SYNC, subscriptionGroupIdentifier: "21000000",
  type: "Auto-Renewable Subscription", environment: "Sandbox", inAppOwnershipType: "PURCHASED", storefront: "USA",
  transactionReason: "PURCHASE", purchaseDate: Date.now() - DAY, originalPurchaseDate: Date.now() - DAY,
  expiresDate: Date.now() + 29 * DAY, signedDate: Date.now(), ...overrides,
});
const renewal = (overrides: Record<string, unknown> = {}) => ({
  originalTransactionId: ORIGINAL, autoRenewProductId: APP_STORE_SYNC, productId: APP_STORE_SYNC, autoRenewStatus: 1,
  environment: "Sandbox", signedDate: Date.now(), ...overrides,
});
const verify = async (account: Account, payload: Record<string, unknown>, signer = chain) =>
  call("/billing/apple/verify", json("POST", { transaction: await signJws(signer, payload) }, account.headers));
async function notify(type: string, tx?: Record<string, unknown>, options: { subtype?: string; renewal?: Record<string, unknown>; data?: Record<string, unknown> } = {}) {
  const signedPayload = await signJws(chain, {
    notificationType: type, subtype: options.subtype, notificationUUID: crypto.randomUUID(), version: "2.0", signedDate: Date.now(),
    data: {
      appAppleId: APP_STORE_APP_ID, bundleId: APP_STORE_BUNDLE, bundleVersion: "2", environment: tx?.environment ?? "Sandbox",
      signedTransactionInfo: tx && await signJws(chain, tx),
      signedRenewalInfo: options.renewal && await signJws(chain, options.renewal),
      ...options.data,
    },
  });
  return call("/billing/apple/notifications", json("POST", { signedPayload }));
}
const row = (id = ORIGINAL) => env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?1").bind(`apple:${id}`)
  .first<{ user_id: string | null; status: string; current_period_end: string; cancel_at: string | null }>();
const me = async (account: Account) => (await call("/me", { headers: account.headers })).json() as Promise<{
  subscription: { provider: string; status: string; renewsAt: string | null; endsAt: string | null } | null; sync: { active: boolean };
}>;

describe("Apple's signed data", () => {
  const payload = { signedDate: Date.now(), hello: "world" };
  it("pins Apple Root CA - G3", () => {
    expect(appleRoots.has("63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179")).toBe(true);
  });
  it("accepts a JWS whose chain ends in a pinned root", async () => {
    expect(await verifyAppleJws(await signJws(chain, payload))).toEqual(payload);
  });
  it("refuses a chain whose root isn't pinned, however well formed", async () => {
    expect(await verifyAppleJws(await signJws(await appleLikeChain(), payload))).toBeNull();
  });
  it("refuses a tampered payload or signature", async () => {
    const [head, body, signature] = (await signJws(chain, payload)).split(".");
    const forged = base64url(utf8(JSON.stringify({ ...payload, hello: "forged" })));
    expect(await verifyAppleJws(`${head}.${forged}.${signature}`)).toBeNull();
    const flipped = base64url(Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c, i) => c.charCodeAt(0) ^ (i === 5 ? 1 : 0)));
    expect(await verifyAppleJws(`${head}.${body}.${flipped}`)).toBeNull();
  });
  it("checks each certificate's signature, not just the names in the chain", async () => {
    const other = await appleLikeChain();
    expect(await verifyAppleJws(await signJws({ ...chain, intermediate: other.intermediate }, payload))).toBeNull();
    const selfSigned = await certificate({ name: "Test App Store signing", curve: "P-256", markers: [APPLE_LEAF] });
    expect(await verifyAppleJws(await signJws({ ...chain, leaf: selfSigned }, payload))).toBeNull();
  });
  it("needs Apple's marker extensions and a CA intermediate", async () => {
    for (const broken of [
      await appleLikeChain({ leaf: { markers: [] } }),
      await appleLikeChain({ intermediate: { markers: [] } }),
      await appleLikeChain({ intermediate: { ca: false } }),
    ]) {
      appleRoots.add(broken.rootSha256);
      expect(await verifyAppleJws(await signJws(broken, payload))).toBeNull();
      appleRoots.delete(broken.rootSha256);
    }
  });
  it("needs every certificate valid when Apple signed the data", async () => {
    const expired = await appleLikeChain({ leaf: { notBefore: Date.now() - 10 * DAY, notAfter: Date.now() - DAY } });
    appleRoots.add(expired.rootSha256);
    expect(await verifyAppleJws(await signJws(expired, payload))).toBeNull();
    // Signed while the certificate was valid: a transaction restored later still verifies.
    const old = { signedDate: Date.now() - 2 * DAY };
    expect(await verifyAppleJws(await signJws(expired, old))).toEqual(old);
    expect(await verifyAppleJws(await signJws(chain, { hello: "no date" }))).toBeNull();
    appleRoots.delete(expired.rootSha256);
  });
  it("refuses other algorithms, short chains and garbage", async () => {
    expect(await verifyAppleJws(await signJws(chain, payload, { alg: "HS256" }))).toBeNull();
    expect(await verifyAppleJws(await signJws(chain, payload, { alg: "none" }))).toBeNull();
    const [head, body, signature] = (await signJws(chain, payload)).split(".");
    const x5c = (JSON.parse(atob(head.replace(/-/g, "+").replace(/_/g, "/"))) as { x5c: string[] }).x5c;
    const short = base64url(utf8(JSON.stringify({ alg: "ES256", x5c: x5c.slice(0, 2) })));
    expect(await verifyAppleJws(`${short}.${body}.${signature}`)).toBeNull();
    for (const junk of [undefined, 42, "", "a.b", "a.b.c", "....", `${head}.${body}`]) expect(await verifyAppleJws(junk)).toBeNull();
  });
});

describe("App Store purchases", () => {
  it("gives the app a stable UUID for appAccountToken, and the product to sell", async () => {
    const account = await signIn();
    const context = await (await call("/billing/apple/context", { headers: account.headers })).json() as { appAccountToken: string; productId: string };
    expect(context).toEqual({ appAccountToken: account.token, productId: APP_STORE_SYNC });
    expect(context.appAccountToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await appAccountToken(account.id)).toBe(context.appAccountToken);
    expect(await appAccountToken("usr_someone_else")).not.toBe(context.appAccountToken);
  });
  it("turns Sync on for a verified purchase made for this account, once", async () => {
    const account = await signIn();
    const purchase = transaction({ appAccountToken: account.token.toUpperCase() });
    for (let i = 0; i < 2; i++) {
      const response = await verify(account, purchase);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ active: true });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first("n")).toBe(1);
    expect(await row()).toMatchObject({ user_id: account.id, status: "active", cancel_at: null });
    expect(await syncActive(env.DB, account.id)).toBe(true);
    const overview = await me(account);
    expect(overview.subscription).toMatchObject({ provider: "apple", status: "active", renewsAt: new Date(purchase.expiresDate).toISOString(), endsAt: null });
    expect(overview.sync.active).toBe(true);
    expect(calls).toEqual([]);
  });
  it("needs a sign-in", async () => {
    const response = await call("/billing/apple/verify", json("POST", { transaction: await signJws(chain, transaction()) }));
    expect(response.status).toBe(401);
  });
  it.each([
    ["another app", { bundleId: "app.urbudget.native" }],
    ["another product", { productId: "app.urbudget.lifetime" }],
    ["a one-time purchase", { type: "Non-Consumable" }],
    ["Xcode's local testing", { environment: "Xcode" }],
    ["a Family Sharing copy", { inAppOwnershipType: "FAMILY_SHARED" }],
    ["no expiry", { expiresDate: undefined }],
  ])("refuses %s", async (_, overrides) => {
    const account = await signIn();
    const response = await verify(account, transaction({ appAccountToken: account.token, ...overrides }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_purchase" });
    expect(await syncActive(env.DB, account.id)).toBe(false);
  });
  it("refuses a tampered transaction and one signed outside Apple's chain", async () => {
    const account = await signIn();
    const [head, , signature] = (await signJws(chain, transaction({ appAccountToken: account.token }))).split(".");
    const forged = base64url(utf8(JSON.stringify(transaction({ appAccountToken: account.token, expiresDate: Date.now() + 3650 * DAY }))));
    expect((await call("/billing/apple/verify", json("POST", { transaction: `${head}.${forged}.${signature}` }, account.headers))).status).toBe(400);
    expect((await verify(account, transaction({ appAccountToken: account.token }), await appleLikeChain())).status).toBe(400);
    expect((await call("/billing/apple/verify", json("POST", { transaction: 7 }, account.headers))).status).toBe(400);
    expect(await syncActive(env.DB, account.id)).toBe(false);
  });
  it("refuses a purchase made for another account, saying why", async () => {
    const owner = await signIn("owner@example.com");
    const other = await signIn("other@example.com");
    const purchase = transaction({ appAccountToken: owner.token });
    const response = await verify(other, purchase);
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toContain("another UrBudget account");
    expect((await verify(owner, purchase)).status).toBe(200);
    expect((await verify(other, transaction({ appAccountToken: other.token, purchaseDate: Date.now() - 2 * DAY }))).status).toBe(400);
    expect(await syncActive(env.DB, other.id)).toBe(false);
    expect(await row()).toMatchObject({ user_id: owner.id });
  });
  it("lets the first account claim a purchase Apple sent without a token, and nobody after", async () => {
    const first = await signIn("first@example.com");
    const second = await signIn("second@example.com");
    const purchase = transaction();
    expect(await (await verify(first, purchase)).json()).toEqual({ active: true });
    expect((await verify(second, purchase)).status).toBe(400);
    expect(await row()).toMatchObject({ user_id: first.id });
  });
  it("moves a subscription to the account that bought it again after it lapsed", async () => {
    const before = await signIn("before@example.com");
    const after = await signIn("after@example.com");
    await verify(before, transaction({ appAccountToken: before.token, purchaseDate: Date.now() - 60 * DAY, expiresDate: Date.now() - 30 * DAY }));
    const again = transaction({ appAccountToken: after.token });
    expect(await (await verify(after, again)).json()).toEqual({ active: true });
    expect(await row()).toMatchObject({ user_id: after.id, status: "active" });
    expect(await syncActive(env.DB, before.id)).toBe(false);
    // The first account can't take it back with its older purchase.
    expect((await verify(before, transaction({ appAccountToken: before.token, purchaseDate: Date.now() - 60 * DAY }))).status).toBe(400);
  });
  it("reports an expired restore without granting Sync", async () => {
    const account = await signIn();
    const lapsed = transaction({ appAccountToken: account.token, purchaseDate: Date.now() - 40 * DAY, expiresDate: Date.now() - 10 * DAY });
    expect(await (await verify(account, lapsed)).json()).toEqual({ active: false });
    expect(await row()).toMatchObject({ status: "canceled" });
    expect(await syncActive(env.DB, account.id)).toBe(false);
  });
  it("keeps the newest period when the app posts an older transaction", async () => {
    const account = await signIn();
    const current = transaction({ appAccountToken: account.token });
    await verify(account, current);
    await verify(account, transaction({ appAccountToken: account.token, purchaseDate: Date.now() - 31 * DAY, expiresDate: Date.now() - DAY }));
    expect(await row()).toMatchObject({ status: "active", current_period_end: new Date(current.expiresDate).toISOString() });
  });
  it("ends Sync at expiry even before a notification, and settles the status", async () => {
    const account = await signIn();
    await verify(account, transaction({ appAccountToken: account.token }));
    await env.DB.prepare("UPDATE subscriptions SET current_period_end = '2000-01-01T00:00:00.000Z'").run();
    await env.DB.prepare("UPDATE apple_subscriptions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(await syncActive(env.DB, account.id)).toBe(false);
    await settleAppleSubscriptions(env);
    expect(await row()).toMatchObject({ status: "canceled" });
    expect((await me(account)).subscription).toMatchObject({ provider: "apple", status: "canceled", renewsAt: null });
  });
  it("points the billing portal at Apple, never at Polar", async () => {
    const account = await signIn();
    await verify(account, transaction({ appAccountToken: account.token }));
    expect(await (await call("/billing/portal", { method: "POST", headers: account.headers })).json()).toEqual({ url: APP_STORE_MANAGE_URL });
    expect(calls).toEqual([]);
  });
  it("counts App Store subscribers on the admin page", async () => {
    const account = await signIn();
    await verify(account, transaction({ appAccountToken: account.token }));
    await env.DB.prepare(`INSERT INTO subscriptions (id, user_id, customer_id, status, updated_at, event_at)
      VALUES ('comp:review', ?1, 'comp', 'active', '2026-01-01', '2026-01-01')`).bind(account.id).run();
    const overview = await (await call("/admin/overview")).json() as { sync: { subscribers: number; byProvider: Record<string, number>; byStatus: Record<string, number> } };
    expect(overview.sync).toMatchObject({ subscribers: 2, byProvider: { apple: 1, comp: 1 }, byStatus: { active: 2 } });
  });
});

describe("App Store Server Notifications", () => {
  async function subscribed() {
    const account = await signIn();
    const first = transaction({ appAccountToken: account.token });
    await verify(account, first);
    return { account, first };
  }
  it("renews: a newer transaction moves the period on", async () => {
    const { account, first } = await subscribed();
    const next = transaction({ appAccountToken: account.token, transactionReason: "RENEWAL", purchaseDate: first.expiresDate, expiresDate: first.expiresDate + 30 * DAY });
    expect((await notify("DID_RENEW", next, { renewal: renewal() })).status).toBe(200);
    expect(await row()).toMatchObject({ status: "active", current_period_end: new Date(next.expiresDate).toISOString() });
    // A late, duplicated delivery of the first purchase changes nothing.
    expect((await notify("SUBSCRIBED", first, { subtype: "INITIAL_BUY" })).status).toBe(200);
    expect(await row()).toMatchObject({ current_period_end: new Date(next.expiresDate).toISOString() });
  });
  it("shows a turned-off renewal as the end of the paid period, and keeps Sync until then", async () => {
    const { account, first } = await subscribed();
    await notify("DID_CHANGE_RENEWAL_STATUS", first, { subtype: "AUTO_RENEW_DISABLED", renewal: renewal({ autoRenewStatus: 0 }) });
    const expires = new Date(first.expiresDate).toISOString();
    expect(await row()).toMatchObject({ status: "active", cancel_at: expires });
    expect((await me(account)).subscription).toMatchObject({ renewsAt: null, endsAt: expires });
    expect(await syncActive(env.DB, account.id)).toBe(true);
    // An older renewal info (auto-renew still on) delivered late doesn't undo it.
    await notify("DID_CHANGE_RENEWAL_STATUS", first, { renewal: renewal({ autoRenewStatus: 1, signedDate: Date.now() - DAY }) });
    expect(await row()).toMatchObject({ cancel_at: expires });
  });
  it("keeps Sync through a grace period, then stops it in billing retry", async () => {
    const account = await signIn();
    // The renewal charge failed: the newest transaction's period is over.
    const lapsed = transaction({ appAccountToken: account.token, purchaseDate: Date.now() - 31 * DAY, expiresDate: Date.now() - 1000 });
    expect(await (await verify(account, lapsed)).json()).toEqual({ active: false });
    const tx = { ...lapsed, signedDate: Date.now() + 1 };
    const grace = Date.now() + 6 * DAY;
    await notify("DID_FAIL_TO_RENEW", tx, { subtype: "GRACE_PERIOD", renewal: renewal({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: grace }) });
    expect(await row()).toMatchObject({ status: "past_due", current_period_end: new Date(grace).toISOString() });
    expect(await syncActive(env.DB, account.id)).toBe(true);
    await notify("GRACE_PERIOD_EXPIRED", tx, { renewal: renewal({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: Date.now() - 1000, signedDate: Date.now() + 2 }) });
    expect(await row()).toMatchObject({ status: "unpaid" });
    expect(await syncActive(env.DB, account.id)).toBe(false);
    // Apple's retry succeeds: a new transaction recovers the subscription.
    const recovered = transaction({ appAccountToken: account.token, transactionReason: "RENEWAL", purchaseDate: Date.now(), expiresDate: Date.now() + 30 * DAY });
    await notify("DID_RENEW", recovered, { subtype: "BILLING_RECOVERY", renewal: renewal({ signedDate: Date.now() + 3 }) });
    expect(await row()).toMatchObject({ status: "active" });
    expect(await syncActive(env.DB, account.id)).toBe(true);
  });
  it("doesn't let an older delivery that read the subscription first overwrite a newer one", async () => {
    const { account, first } = await subscribed();
    const next = transaction({ appAccountToken: account.token, purchaseDate: first.expiresDate, expiresDate: first.expiresDate + 30 * DAY });
    let entered!: () => void, resume!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { resume = resolve; });
    let pause = true;
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const statement = prepare(sql);
      if (!sql.startsWith("SELECT * FROM apple_subscriptions")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...args) => {
        const bound = bind(...args);
        const first = bound.first.bind(bound);
        bound.first = async (...rest) => {
          const result = await first(...rest);
          if (pause) { pause = false; entered(); await released; }
          return result;
        };
        return bound;
      };
      return statement;
    };
    // The auto-renew change was signed before the renewal, but its delivery reads first.
    const late = notify("DID_CHANGE_RENEWAL_STATUS", first, { renewal: renewal({ autoRenewStatus: 0, signedDate: first.expiresDate - DAY }) });
    await paused;
    expect((await notify("DID_RENEW", next, { renewal: renewal({ signedDate: first.expiresDate + 1 }) })).status).toBe(200);
    resume();
    expect((await late).status).toBe(200);
    expect(await row()).toMatchObject({ status: "active", cancel_at: null, current_period_end: new Date(next.expiresDate).toISOString() });
    expect(await env.DB.prepare("SELECT revision FROM apple_subscriptions").first("revision")).toBe(3);
  });
  it("expires", async () => {
    const { account, first } = await subscribed();
    const ended = { ...first, expiresDate: Date.now() - 1000, signedDate: Date.now() + 1 };
    expect((await notify("EXPIRED", ended, { subtype: "VOLUNTARY", renewal: renewal({ autoRenewStatus: 0 }) })).status).toBe(200);
    expect(await row()).toMatchObject({ status: "canceled" });
    expect(await syncActive(env.DB, account.id)).toBe(false);
  });
  it("revokes on a refund, and restores if the refund is reversed", async () => {
    const { account, first } = await subscribed();
    const refunded = { ...first, revocationDate: Date.now(), revocationReason: 0, signedDate: Date.now() + 1 };
    await notify("REFUND", refunded);
    expect(await row()).toMatchObject({ status: "canceled", cancel_at: new Date(refunded.revocationDate).toISOString() });
    expect(await syncActive(env.DB, account.id)).toBe(false);
    // The app posting its stale copy, signed before the refund, doesn't bring Sync back.
    expect(await (await verify(account, first)).json()).toEqual({ active: false });
    await notify("REFUND_REVERSED", { ...first, signedDate: Date.now() + 2 });
    expect(await row()).toMatchObject({ status: "active" });
    expect(await syncActive(env.DB, account.id)).toBe(true);
  });
  it("revokes when Apple revokes access", async () => {
    const { account, first } = await subscribed();
    await notify("REVOKE", { ...first, revocationDate: Date.now(), signedDate: Date.now() + 1 });
    expect(await syncActive(env.DB, account.id)).toBe(false);
  });
  it("answers 200 to a test, a summary and a subscription no account has claimed, and changes nothing", async () => {
    expect((await notify("TEST", undefined)).status).toBe(200);
    const summary = await signJws(chain, { notificationType: "RENEWAL_EXTENSION", subtype: "SUMMARY", signedDate: Date.now(), summary: { bundleId: APP_STORE_BUNDLE } });
    expect((await call("/billing/apple/notifications", json("POST", { signedPayload: summary }))).status).toBe(200);
    expect((await notify("SUBSCRIBED", transaction(), { subtype: "INITIAL_BUY" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM apple_subscriptions").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first("n")).toBe(0);
  });
  it("refuses notifications that aren't Apple's or aren't for this app", async () => {
    const { account, first } = await subscribed();
    const refund = { ...first, revocationDate: Date.now(), signedDate: Date.now() + 1 };
    const refused = [
      await notify("REFUND", refund, { data: { bundleId: "com.example.other" } }),
      await notify("REFUND", refund, { data: { environment: "Production" } }),
      await notify("REFUND", { ...refund, environment: "Production" }, { data: { appAppleId: 123 } }),
      await notify("REFUND", { ...refund, bundleId: "com.example.other" }),
      await call("/billing/apple/notifications", json("POST", { signedPayload: await signJws(await appleLikeChain(), { notificationType: "REFUND", signedDate: Date.now(), data: {} }) })),
      await call("/billing/apple/notifications", json("POST", { signedPayload: "not.a.jws" })),
      await call("/billing/apple/notifications", { method: "POST", body: "{" }),
    ];
    for (const response of refused) expect(response.status).toBe(400);
    expect(await syncActive(env.DB, account.id)).toBe(true);
  });
  it("ignores another product's notification", async () => {
    const { account, first } = await subscribed();
    expect((await notify("REFUND", { ...first, productId: "app.urbudget.other", revocationDate: Date.now(), signedDate: Date.now() + 1 })).status).toBe(200);
    expect(await syncActive(env.DB, account.id)).toBe(true);
  });
});

describe("Account deletion with an App Store subscription", () => {
  it("deletes the account without asking Polar to cancel, and keeps the subscription unclaimable", async () => {
    const account = await signIn();
    const purchase = transaction({ appAccountToken: account.token });
    await verify(account, purchase);
    const deleted = await call("/me", json("DELETE", { confirm: account.email }, account.headers));
    expect(deleted.status).toBe(200);
    expect(calls).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deleted_billing_customers").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT user_id FROM apple_subscriptions").first("user_id")).toBeNull();
    // Renewals keep the record current without recreating an account or an entitlement.
    const next = transaction({ appAccountToken: account.token, purchaseDate: purchase.expiresDate, expiresDate: purchase.expiresDate + 30 * DAY });
    expect((await notify("DID_RENEW", next)).status).toBe(200);
    expect(await env.DB.prepare("SELECT expires_at FROM apple_subscriptions").first("expires_at")).toBe(new Date(next.expiresDate).toISOString());
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id IS NOT NULL").first("n")).toBe(0);
    // A new account with the same email gets a new token, so the old purchase isn't its.
    const again = await signIn(account.email);
    expect(again.token).not.toBe(account.token);
    expect((await verify(again, next)).status).toBe(400);
  });
  it("leaves a complimentary review subscription working beside the App Store", async () => {
    const account = await signIn("review@urbudget.app");
    await env.DB.prepare(`INSERT INTO subscriptions (id, user_id, customer_id, status, updated_at, event_at)
      VALUES ('comp:review', ?1, 'comp', 'active', '2026-01-01', '2026-01-01')`).bind(account.id).run();
    expect(await syncActive(env.DB, account.id)).toBe(true);
    expect((await me(account)).subscription).toMatchObject({ provider: "comp", status: "active" });
    // App Review can still buy in Sandbox; the purchase then shows as the App Store's.
    expect(await (await verify(account, transaction({ appAccountToken: account.token }))).json()).toEqual({ active: true });
    expect((await me(account)).subscription).toMatchObject({ provider: "apple" });
    expect((await call("/me", json("DELETE", { confirm: account.email }, account.headers))).status).toBe(200);
  });
});
