import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Regression coverage for concurrent billing, authentication and encrypted sync.
// All state is synthetic in-memory SQLite/R2; all external fetches are mocked.
import { app } from "../src/index";
import { signWebhook } from "../src/billing/polar";
import { testEnv } from "./fakes";
import { cleanupSyncObjects } from "../src/sync";
import { sha256 } from "../src/util";

let env: Awaited<ReturnType<typeof testEnv>>;
let calls: Array<{ url: string; body: unknown }>;
beforeEach(async () => {
  env = await testEnv();
  calls = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (/\/v1\/subscriptions\/[\w-]+$/.test(String(url)) && init?.method === "DELETE") return Response.json({ id: "sub" });
    if (String(url).endsWith("/v1/customer-sessions/")) return Response.json({ detail: "Customer not found" }, { status: 404 });
    throw new Error("Unexpected external request blocked by review harness");
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); env.DB.sqlite.close(); });
const json = (method: string, body: unknown, headers = {}) => ({ method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const call = (path: string, init: RequestInit = {}) => app.request(`/api/v1${path}`, init, env);
async function signIn(email = "audit@example.com") {
  const start = await (await call("/auth/start", json("POST", { email }))).json();
  const verified = await (await call("/auth/verify", json("POST", { email, code: start.devCode, client: "desktop" }))).json();
  return { userId: verified.user.id, email, headers: { Authorization: `Bearer ${verified.token}` } };
}
async function webhook(type: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  const id = `review_${crypto.randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000);
  return call("/billing/webhook", { method: "POST", body, headers: {
    "webhook-id": id, "webhook-timestamp": String(ts),
    "webhook-signature": await signWebhook(env.POLAR_WEBHOOK_SECRET!, id, ts, body),
  } });
}
const subscription = (extra = {}) => ({ id: "sub_review", status: "active", customer_id: "cus_review", customer: { email: "audit@example.com", external_id: null }, product_id: "prod-sync", current_period_end: "2099-01-01T00:00:00Z", modified_at: "2026-10-20T01:00:00Z", ...extra });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function pauseNextSubscriptionRead() {
  const read = deferred(), release = deferred();
  const prepare = env.DB.prepare.bind(env.DB);
  let armed = true;
  env.DB.prepare = (sql: string) => {
    const original = prepare(sql);
    if (!sql.includes("SELECT user_id, event_at FROM subscriptions")) return original;
    const bind = original.bind.bind(original);
    original.bind = (...args: unknown[]) => {
      const statement = bind(...args);
      const first = statement.first.bind(statement);
      statement.first = async (...args: unknown[]) => {
        const row = await first(...args);
        if (armed) { armed = false; read.resolve(); await release.promise; }
        return row;
      };
      return statement;
    };
    return original;
  };
  return { read, release };
}

it("does not recreate a deleted account from a delayed cancellation", async () => {
  const user = await signIn();
  const customer = { email: user.email, external_id: user.userId };
  expect((await webhook("subscription.active", subscription({ customer }))).status).toBe(200);
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
  expect((await webhook("subscription.canceled", subscription({ customer, status: "canceled", modified_at: "2026-10-20T02:00:00Z" }))).status).toBe(200);
  const recreated = await env.DB.prepare("SELECT id, email FROM users").first();
  expect(recreated).toBeNull();
  expect(await env.DB.prepare("SELECT user_id FROM subscriptions").first("user_id")).toBeNull();
});

it("handles a subscription completing after the deletion cancellation snapshot", async () => {
  const user = await signIn();
  const customer = { email: user.email, external_id: user.userId };
  await webhook("subscription.active", subscription({ customer }));
  const entered = deferred(), release = deferred();
  const fetcher = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/v1/subscriptions/sub_review") && init?.method === "DELETE") {
      entered.resolve(); await release.promise;
    }
    return fetcher(url, init);
  });
  const deletion = call("/me", json("DELETE", { confirm: user.email }, user.headers));
  await entered.promise;
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).toBe(409);
  expect((await call("/billing/checkout", json("POST", { plan: "sync" }, user.headers))).status).toBe(409);
  const arriving = await webhook("subscription.active", subscription({ id: "sub_new", customer }));
  release.resolve();
  expect((await deletion).status).toBe(200);
  // A callback may be retried while deletion owns the account, but its eventual
  // successful delivery must stop the new charge rather than orphan it.
  if (arriving.status !== 200)
    expect((await webhook("subscription.active", subscription({ id: "sub_new", customer }))).status).toBe(200);
  expect(calls.some((c) => c.url.endsWith("/v1/subscriptions/sub_new"))).toBe(true);
  expect(await env.DB.prepare("SELECT status FROM subscriptions WHERE id = 'sub_new'").first("status")).toBe("canceled");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
});

it("releases a failed deletion guard and preserves the account and cloud copies for retry", async () => {
  const user = await signIn();
  await webhook("subscription.active", subscription({ customer: { email: user.email, external_id: user.userId } }));
  await env.DB.prepare("INSERT INTO sync_budgets (user_id,budget_id,revision,object_key,size,updated_at) VALUES (?1,'b',1,'object',5,'2026-01-01')").bind(user.userId).run();
  await env.SYNC.put("object", "bytes");
  const fetcher = globalThis.fetch;
  vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).not.toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM account_deletions").first("n")).toBe(0);
  expect(env.SYNC.objects.has("object")).toBe(true);
  vi.stubGlobal("fetch", fetcher);
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).toBe(200);
  expect(env.SYNC.objects.size).toBe(0);
});

it("retries a late subscription cancellation without recreating a deleted owner", async () => {
  const user = await signIn();
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).toBe(200);
  const event = subscription({ customer: { email: user.email, external_id: user.userId } });
  const fetcher = globalThis.fetch;
  vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
  expect((await webhook("subscription.active", event)).status).not.toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
  vi.stubGlobal("fetch", fetcher);
  expect((await webhook("subscription.active", event)).status).toBe(200);
  expect(await env.DB.prepare("SELECT status,user_id FROM subscriptions").first()).toEqual({ status: "canceled", user_id: null });
});

it("preserves cloud copies when the account deletion transaction fails", async () => {
  const user = await syncingUser();
  await call("/sync/budgets/b", { method: "PUT", headers: { ...user.headers, "If-Match": "0" }, body: "important ciphertext" });
  env.DB.sqlite.exec("CREATE TRIGGER fail_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END");
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).toBe(500);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_budgets").first("n")).toBe(1);
  expect(env.SYNC.objects.size).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_object_garbage").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM account_deletions").first("n")).toBe(0);
  env.DB.sqlite.exec("DROP TRIGGER fail_user_delete");
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).toBe(200);
  expect(env.SYNC.objects.size).toBe(0);
});

it("preserves cloud copies and billing identity when a deletion loses its lease before commit", async () => {
  const user = await syncingUser();
  await call("/sync/budgets/b", { method: "PUT", headers: { ...user.headers, "If-Match": "0" }, body: "important ciphertext" });
  const prepare = env.DB.prepare.bind(env.DB);
  let armed = true;
  env.DB.prepare = (sql) => {
    const original = prepare(sql);
    if (!sql.startsWith("SELECT 1 FROM account_deletions WHERE user_id = ?1 AND token = ?2")) return original;
    const bind = original.bind.bind(original);
    original.bind = (...args) => {
      const statement = bind(...args);
      const first = statement.first.bind(statement);
      statement.first = async (...args) => {
        const row = await first(...args);
        if (armed) {
          armed = false;
          await prepare("UPDATE account_deletions SET token = 'replacement' WHERE user_id = ?1").bind(user.userId).run();
        }
        return row;
      };
      return statement;
    };
    return original;
  };
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).toBe(409);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_budgets").first("n")).toBe(1);
  expect(env.SYNC.objects.size).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deleted_billing_customers").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT token FROM account_deletions").first("token")).toBe("replacement");
});

it("reclaims an interrupted deletion guard without leaving the account stuck", async () => {
  const user = await signIn();
  await env.DB.prepare("INSERT INTO account_deletions (user_id,token,started_at) VALUES (?1,'interrupted','2000-01-01')").bind(user.userId).run();
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM account_deletions").first("n")).toBe(0);
});

it("keeps the newest subscription state when webhook handlers overlap", async () => {
  await signIn();
  await webhook("subscription.active", subscription());
  const gate = pauseNextSubscriptionRead();
  const older = webhook("subscription.updated", subscription({ modified_at: "2026-10-20T02:00:00Z" }));
  await gate.read.promise;
  expect((await webhook("subscription.canceled", subscription({ status: "canceled", modified_at: "2026-10-20T03:00:00Z" }))).status).toBe(200);
  gate.release.resolve();
  expect((await older).status).toBe(200);
  const row = await env.DB.prepare("SELECT status, event_at FROM subscriptions WHERE id = ?1").bind("sub_review").first();
  expect(row).toEqual({ status: "canceled", event_at: "2026-10-20T03:00:00Z" });
});

it("rejects an in-flight old-key upload after reset and removes its orphan object", async () => {
  const user = await signIn();
  await webhook("subscription.active", subscription({ customer: { email: user.email, external_id: user.userId } }));
  expect((await call("/sync/key", json("PUT", { salt: "old_salt_0123456789", check: "old-key-check" }, user.headers))).status).toBe(200);
  const entered = deferred(), release = deferred();
  const put = env.SYNC.put.bind(env.SYNC);
  env.SYNC.put = async (...args: unknown[]) => { entered.resolve(); await release.promise; return put(...args); };
  const upload = call("/sync/budgets/newbudget", { method: "PUT", headers: { ...user.headers, "If-Match": "0", "X-Sync-Generation": "0" }, body: "ciphertext-encrypted-with-old-key" });
  await entered.promise;
  expect((await call("/sync/key", json("PUT", { salt: "new_salt_0123456789", check: "new-key-check", reset: true }, user.headers))).status).toBe(200);
  release.resolve();
  expect((await upload).status).toBe(409);
  expect(await (await call("/sync/key", { headers: user.headers })).json()).toMatchObject({ check: "new-key-check" });
  expect((await call("/sync/budgets/newbudget", { headers: { ...user.headers, "X-Sync-Generation": "1" } })).status).toBe(404);
  expect(env.SYNC.objects.size).toBe(0);
});

it("consumes a correct OTP once under concurrent verification", async () => {
  const email = "audit@example.com";
  const start = await (await call("/auth/start", json("POST", { email }))).json();
  const results = await Promise.all(Array.from({ length: 10 }, () => call("/auth/verify", json("POST", { email, code: start.devCode, client: "desktop" }))));
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(results.filter((r) => r.status === 400)).toHaveLength(9);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(1);
});

it("reserves at most five OTP guesses across concurrent requests", async () => {
  const email = "audit@example.com";
  const start = await (await call("/auth/start", json("POST", { email }))).json();
  const wrong = start.devCode === "000000" ? "000001" : "000000";
  const results = await Promise.all(Array.from({ length: 20 }, () => call("/auth/verify", json("POST", { email, code: wrong, client: "desktop" }))));
  const errors = await Promise.all(results.map(async (r) => (await r.json()).error));
  expect(errors.filter((e) => e === "invalid_code")).toHaveLength(5);
  expect(errors.filter((e) => e === "too_many_attempts")).toHaveLength(15);
  expect(await env.DB.prepare("SELECT attempts FROM login_codes WHERE email = ?1").bind(email).first("attempts")).toBe(5);
});

it("routes a Google subscriber to Play without contacting Polar", async () => {
  const user = await signIn();
  await env.DB.prepare("INSERT INTO subscriptions (id,user_id,customer_id,status,current_period_end,updated_at,event_at) VALUES (?1,?2,?3,'active','2099-01-01T00:00:00Z','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z')")
    .bind("google:synthetic", user.userId, `google:${user.userId}`).run();
  const response = await call("/billing/portal", { method: "POST", headers: user.headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "https://play.google.com/store/account/subscriptions?package=app.urbudget" });
  expect(calls).toHaveLength(0);
  expect(await (await call("/me", { headers: user.headers })).json()).toMatchObject({ subscription: { provider: "google" } });
});

it("enforces the account budget quota at commit despite concurrent uploads", async () => {
  const user = await signIn();
  await webhook("subscription.active", subscription({ customer: { email: user.email, external_id: user.userId } }));
  await call("/sync/key", json("PUT", { salt: "salt_0123456789012345", check: "check" }, user.headers));
  const entered = deferred(), release = deferred();
  const put = env.SYNC.put.bind(env.SYNC);
  let uploads = 0;
  env.SYNC.put = async (...args: unknown[]) => {
    if (++uploads === 51) entered.resolve();
    await release.promise;
    return put(...args);
  };
  const requests = Array.from({ length: 51 }, (_, i) => call(`/sync/budgets/b${i}`, {
    method: "PUT", headers: { ...user.headers, "If-Match": "0" }, body: "x",
  }));
  await entered.promise;
  release.resolve();
  const results = await Promise.all(requests);
  expect(results.filter((r) => r.status === 200)).toHaveLength(50);
  expect(results.filter((r) => r.status === 413)).toHaveLength(1);
  expect(env.SYNC.objects.size).toBe(50);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_budgets").first("n")).toBe(50);
});

async function syncingUser() {
  const user = await signIn();
  await webhook("subscription.active", subscription({ customer: { email: user.email, external_id: user.userId } }));
  await call("/sync/key", json("PUT", { salt: "salt_0123456789012345", check: "check" }, user.headers));
  return user;
}

it("blocks stale and legacy clients after reset without deleting new-generation uploads", async () => {
  const user = await syncingUser();
  const upload = (headers: Record<string, string>) => call("/sync/budgets/new", { method: "PUT", headers: { ...headers, "If-Match": "0" }, body: "new-key-ciphertext" });
  const reset = await call("/sync/key", json("PUT", { salt: "salt_0123456789012345", check: "new", reset: true }, user.headers));
  expect(await reset.json()).toEqual({ ok: true, generation: 1 });
  const current = { ...user.headers, "X-Sync-Generation": "1" };
  expect((await upload(current)).status).toBe(200);
  for (const method of ["GET", "DELETE", "PUT"]) {
    const stale = await call("/sync/budgets/new", { method, headers: { ...user.headers, "X-Sync-Generation": "0", "If-Match": "1" }, ...(method === "PUT" ? { body: "stale" } : {}) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "sync_key_changed" });
    expect((await call("/sync/budgets/new", { method, headers: user.headers, ...(method === "PUT" ? { body: "stale" } : {}) })).status).toBe(428);
  }
  expect((await call("/sync/budgets", { headers: user.headers })).status).toBe(428);
  expect((await call("/sync/key", json("PUT", { salt: "salt_0123456789012345", check: "stale", reset: true }, { ...user.headers, "X-Sync-Generation": "0" }))).status).toBe(409);
  expect(await (await call("/sync/budgets/new", { headers: current })).text()).toBe("new-key-ciphertext");
  expect((await call("/sync/budgets/new", { method: "DELETE", headers: current })).status).toBe(200);
  expect(env.SYNC.objects.size).toBe(0);
});

it("atomically enforces the byte quota for different budgets without allocating large blobs", async () => {
  const user = await syncingUser();
  // Metadata-only fixture: leave one byte available in the account quota.
  await env.DB.prepare("INSERT INTO sync_budgets (user_id,budget_id,revision,object_key,size,updated_at) VALUES (?1,'existing',1,'existing',?2,'2026-10-20')")
    .bind(user.userId, 1024 * 1024 * 1024 - 1).run();
  const entered = deferred(), release = deferred();
  const put = env.SYNC.put.bind(env.SYNC);
  let uploads = 0;
  env.SYNC.put = async (...args: unknown[]) => { if (++uploads === 2) entered.resolve(); await release.promise; return put(...args); };
  const pending = ["one", "two"].map((id) => call(`/sync/budgets/${id}`, { method: "PUT", headers: { ...user.headers, "If-Match": "0" }, body: "x" }));
  await entered.promise;
  release.resolve();
  const responses = await Promise.all(pending);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 413]);
  expect(await env.DB.prepare("SELECT SUM(size) AS n FROM sync_budgets").first("n")).toBe(1024 * 1024 * 1024);
  expect(env.SYNC.objects.size).toBe(1);
});

it("retries failed object cleanup after reset without touching the new upload", async () => {
  const user = await syncingUser();
  await call("/sync/budgets/b", { method: "PUT", headers: { ...user.headers, "If-Match": "0" }, body: "old" });
  const remove = env.SYNC.delete.bind(env.SYNC);
  env.SYNC.delete = async () => { throw new Error("synthetic storage outage"); };
  expect((await call("/sync/key", json("PUT", { salt: "salt_0123456789012345", check: "new", reset: true }, user.headers))).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_object_garbage").first("n")).toBe(1);
  await call("/sync/budgets/b", { method: "PUT", headers: { ...user.headers, "If-Match": "0", "X-Sync-Generation": "1" }, body: "new" });
  env.SYNC.delete = remove;
  await cleanupSyncObjects(env);
  expect(env.SYNC.objects.size).toBe(1);
  expect(await (await call("/sync/budgets/b", { headers: { ...user.headers, "X-Sync-Generation": "1" } })).text()).toBe("new");
});

it("queues objects removed by account cascades for durable cleanup", async () => {
  const user = await syncingUser();
  await call("/sync/budgets/b", { method: "PUT", headers: { ...user.headers, "If-Match": "0" }, body: "encrypted" });
  await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(user.userId).run();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_object_garbage").first("n")).toBe(1);
  await cleanupSyncObjects(env);
  expect(env.SYNC.objects.size).toBe(0);
});

it("does not recreate a deleted guest customer's account from a previously unseen subscription", async () => {
  const user = await signIn();
  await webhook("subscription.active", subscription());
  expect((await call("/me", json("DELETE", { confirm: user.email }, user.headers))).status).toBe(200);
  expect((await webhook("subscription.canceled", subscription({ id: "sub_delayed", status: "canceled" }))).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
  // Explicit sign-in remains allowed; deletion does not permanently ban an email.
  const returning = await signIn();
  expect(returning.userId).not.toBe(user.userId);
  expect((await webhook("subscription.active", subscription({ id: "sub_new", customer_id: "cus_new", customer: { email: user.email, external_id: returning.userId } }))).status).toBe(200);
  expect(await env.DB.prepare("SELECT user_id FROM subscriptions WHERE id = 'sub_new'").first("user_id")).toBe(returning.userId);
});

it("consumes a browser sign-in link once even when opened concurrently", async () => {
  const user = await signIn();
  const { url } = await (await call("/auth/web-link", json("POST", { next: "/account/" }, user.headers))).json();
  const responses = await Promise.all(Array.from({ length: 10 }, () => app.request(url, {}, env)));
  expect(responses.filter((r) => r.headers.has("Set-Cookie"))).toHaveLength(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'web'").first("n")).toBe(1);
});

it("does not consume a replacement OTP when an older verification resumes", async () => {
  const email = "audit@example.com";
  const start = await (await call("/auth/start", json("POST", { email }))).json();
  const entered = deferred(), release = deferred();
  const prepare = env.DB.prepare.bind(env.DB);
  let pause = true;
  env.DB.prepare = (sql) => {
    const original = prepare(sql);
    if (!sql.includes("RETURNING code_hash, attempts")) return original;
    const bind = original.bind.bind(original);
    original.bind = (...args) => {
      const statement = bind(...args);
      const first = statement.first.bind(statement);
      statement.first = async (...args) => {
        const row = await first(...args);
        if (pause) { pause = false; entered.resolve(); await release.promise; }
        return row;
      };
      return statement;
    };
    return original;
  };
  const old = call("/auth/verify", json("POST", { email, code: start.devCode, client: "desktop" }));
  await entered.promise;
  const replacement = start.devCode === "999999" ? "000000" : "999999";
  await env.DB.prepare("UPDATE login_codes SET code_hash = ?2, attempts = 0 WHERE email = ?1")
    .bind(email, await sha256(`login:${email}:${replacement}`)).run();
  release.resolve();
  expect((await old).status).toBe(400);
  expect((await call("/auth/verify", json("POST", { email, code: replacement, client: "desktop" }))).status).toBe(200);
});

it.each([false, true])("preserves the correct object when a database write fails (committed=%s)", async (committed) => {
  const user = await syncingUser();
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const original = prepare(sql);
    if (!sql.includes("INSERT INTO sync_budgets")) return original;
    const bind = original.bind.bind(original);
    original.bind = (...args) => {
      const statement = bind(...args);
      const run = statement.run.bind(statement);
      statement.run = async () => { if (committed) await run(); throw new Error("synthetic uncertain write result"); };
      return statement;
    };
    return original;
  };
  const upload = await call("/sync/budgets/b", { method: "PUT", headers: { ...user.headers, "If-Match": "0" }, body: "important ciphertext" });
  expect(upload.status).toBe(500);
  expect(env.SYNC.objects.size).toBe(committed ? 1 : 0);
  const downloaded = await call("/sync/budgets/b", { headers: user.headers });
  expect(downloaded.status).toBe(committed ? 200 : 404);
  if (committed) expect(await downloaded.text()).toBe("important ciphertext");
});

it("enforces the byte quota for concurrent updates to existing budgets", async () => {
  const user = await syncingUser();
  for (const [id, size] of [["large", 1024 * 1024 * 1024 - 3], ["one", 1], ["two", 1]] as const)
    await env.DB.prepare("INSERT INTO sync_budgets (user_id,budget_id,revision,object_key,size,updated_at) VALUES (?1,?2,1,?2,?3,'2026-10-20')").bind(user.userId, id, size).run();
  const entered = deferred(), release = deferred();
  const put = env.SYNC.put.bind(env.SYNC);
  let uploads = 0;
  env.SYNC.put = async (...args) => { if (++uploads === 2) entered.resolve(); await release.promise; return put(...args); };
  const requests = ["one", "two"].map((id) => call(`/sync/budgets/${id}`, { method: "PUT", headers: { ...user.headers, "If-Match": "1" }, body: "xx" }));
  await entered.promise;
  release.resolve();
  expect((await Promise.all(requests)).map((r) => r.status).sort()).toEqual([200, 413]);
  expect(await env.DB.prepare("SELECT SUM(size) AS n FROM sync_budgets").first("n")).toBe(1024 * 1024 * 1024);
});

it("allows only one concurrent reset of the same key generation", async () => {
  const user = await syncingUser();
  const reset = () => call("/sync/key", json("PUT", { salt: "salt_0123456789012345", check: "new", reset: true }, { ...user.headers, "X-Sync-Generation": "0" }));
  expect((await Promise.all([reset(), reset()])).map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await (await call("/sync/key", { headers: user.headers })).json()).toMatchObject({ generation: 1 });
});
