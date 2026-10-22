// App Store subscriptions to Sync (StoreKit 2), checked on the server against data Apple signed.
// The iOS app posts each transaction StoreKit gives it; App Store Server Notifications V2 report
// renewals, billing retries, grace periods, expiry and refunds. Neither the app's word nor a
// notification's type grants anything: only a transaction Apple signed for this app, the Sync
// product and the account the purchase was made for.
import { Hono } from "hono";
import { requireUser } from "../auth";
import type { AppEnv, Env, User } from "../env";
import { ApiError, now, rateLimit, sha256 } from "../util";
import { verifyAppleJws } from "./apple-jws";
import { SYNC_STATUSES } from "./provider";

export const APP_STORE_BUNDLE = "app.urbudget";
/** UrBudget's Apple ID in App Store Connect, which Production notifications name. */
export const APP_STORE_APP_ID = 6825535486;
export const APP_STORE_SYNC = "app.urbudget.sync.monthly";
/** Where people manage or cancel an App Store subscription; the server can't do either. */
export const APP_STORE_MANAGE_URL = "https://apps.apple.com/account/subscriptions";
/** Sandbox is TestFlight and App Review. Xcode's local StoreKit testing isn't signed by Apple. */
const ENVIRONMENTS = ["Production", "Sandbox"];

interface Transaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  type?: string;
  environment: string;
  appAccountToken?: string;
  inAppOwnershipType?: string;
  purchaseDate: number;
  expiresDate?: number;
  revocationDate?: number;
  signedDate: number;
}
interface RenewalInfo {
  autoRenewStatus?: number;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  signedDate: number;
}
interface Row {
  original_transaction_id: string;
  user_id: string | null;
  app_account_token: string;
  environment: string;
  transaction_id: string;
  purchased_at: number;
  signed_at: number;
  expires_at: string | null;
  revoked_at: string | null;
  auto_renew: number | null;
  billing_retry: number;
  grace_until: string | null;
  renewal_signed_at: number | null;
  revision: number;
}
type State = Pick<Row, "transaction_id" | "purchased_at" | "signed_at" | "expires_at" | "revoked_at" | "auto_renew" |
  "billing_retry" | "grace_until" | "renewal_signed_at">;

const badPurchase = () => new ApiError(400, "invalid_purchase", "The App Store could not verify this purchase for your account.");
// The same code tells the app to stop offering the transaction; the message says why.
const otherAccount = () => new ApiError(400, "invalid_purchase",
  "This App Store subscription belongs to another UrBudget account. Sign in with that account, or manage the subscription in your Apple Account settings.");
const invalidNotification = () => new ApiError(400, "invalid_notification", "Invalid App Store notification.");

/** The UUID the app passes to StoreKit as appAccountToken, which ties a purchase to this account. */
export async function appAccountToken(userId: string): Promise<string> {
  const hash = await sha256(`urbudget:apple:${userId}`);
  // RFC 9562 version 8 (custom): the version digit is 8 and the variant bits are 10.
  const variant = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
const isId = (value: unknown) => typeof value === "string" && /^\d{1,32}$/.test(value);
const isTime = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 8.64e15;

/** Apple's signed transaction for this app, checked field by field; null for anything else. */
async function appTransaction(jws: unknown): Promise<Transaction | null> {
  const t = (await verifyAppleJws(jws)) as Partial<Transaction> | null;
  if (!t || t.bundleId !== APP_STORE_BUNDLE || !ENVIRONMENTS.includes(String(t.environment)) ||
      !isId(t.transactionId) || !isId(t.originalTransactionId) || typeof t.productId !== "string" ||
      !isTime(t.purchaseDate) || !isTime(t.signedDate) ||
      (t.expiresDate !== undefined && !isTime(t.expiresDate)) ||
      (t.revocationDate !== undefined && !isTime(t.revocationDate)) ||
      (t.appAccountToken !== undefined && typeof t.appAccountToken !== "string")) return null;
  return t as Transaction;
}

/** One subscription per account: a Family Sharing copy belongs to whoever bought it. */
const isSync = (t: Transaction) =>
  t.productId === APP_STORE_SYNC && t.type === "Auto-Renewable Subscription" && t.expiresDate !== undefined &&
  t.inAppOwnershipType !== "FAMILY_SHARED";

async function renewalInfo(jws: unknown, transaction: Transaction): Promise<RenewalInfo | null> {
  if (jws === undefined) return null;
  const r = await verifyAppleJws(jws);
  if (!r || r.originalTransactionId !== transaction.originalTransactionId || r.environment !== transaction.environment ||
      !isTime(r.signedDate) || (r.gracePeriodExpiresDate !== undefined && !isTime(r.gracePeriodExpiresDate)))
    throw invalidNotification();
  return r as unknown as RenewalInfo;
}

/**
 * The subscription after one more piece of signed data. A newer purchase replaces the transaction
 * on record, and a later signature of the same one (a refund, or its reversal) replaces the earlier.
 * Older data changes nothing, so deliveries can arrive late, twice or out of order.
 */
function merge(row: Row | null, t: Transaction, renewal: RenewalInfo | null): State {
  const state: State = row ? { ...row } : {
    transaction_id: t.transactionId, purchased_at: t.purchaseDate, signed_at: t.signedDate, expires_at: null,
    revoked_at: null, auto_renew: null, billing_retry: 0, grace_until: null, renewal_signed_at: null,
  };
  const newer = !row || t.purchaseDate > row.purchased_at;
  if (newer || (t.transactionId === row!.transaction_id && t.signedDate >= row!.signed_at)) Object.assign(state, {
    transaction_id: t.transactionId, purchased_at: t.purchaseDate, signed_at: t.signedDate,
    expires_at: iso(t.expiresDate), revoked_at: iso(t.revocationDate),
  });
  // A newer period was paid for: any billing retry before it is over, and renewal info signed
  // before that payment no longer describes the subscription.
  if (newer && row) Object.assign(state, {
    auto_renew: null, billing_retry: 0, grace_until: null,
    renewal_signed_at: Math.max(row.renewal_signed_at ?? 0, t.purchaseDate),
  });
  if (renewal && renewal.signedDate >= (state.renewal_signed_at ?? 0)) Object.assign(state, {
    auto_renew: renewal.autoRenewStatus === 0 || renewal.autoRenewStatus === 1 ? renewal.autoRenewStatus : state.auto_renew,
    billing_retry: renewal.isInBillingRetryPeriod ? 1 : 0,
    grace_until: iso(renewal.gracePeriodExpiresDate),
    renewal_signed_at: renewal.signedDate,
  });
  return state;
}

/** What the subscription is worth now, in the `subscriptions` table's terms. */
function entitlement(state: State, at = Date.now()) {
  if (state.revoked_at) return { status: "canceled", periodEnd: state.revoked_at, cancelAt: state.revoked_at };
  if (state.expires_at && Date.parse(state.expires_at) > at)
    return { status: "active", periodEnd: state.expires_at, cancelAt: state.auto_renew === 0 ? state.expires_at : null };
  // Apple keeps trying to charge; Sync stays on only through a grace period.
  if (state.billing_retry && state.grace_until && Date.parse(state.grace_until) > at)
    return { status: "past_due", periodEnd: state.grace_until, cancelAt: null };
  return { status: state.billing_retry ? "unpaid" : "canceled", periodEnd: state.expires_at, cancelAt: null };
}

/**
 * Saves a verified transaction for its subscription. `claim` is the account posting it from the
 * app; a notification has none and only updates a subscription some account already claimed.
 */
async function record(env: Env, t: Transaction, renewal: RenewalInfo | null, claim?: Pick<User, "id">) {
  const sent = (t.appAccountToken ?? "").toLowerCase();
  if (claim && sent && sent !== (await appAccountToken(claim.id))) throw otherAccount();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare("SELECT * FROM apple_subscriptions WHERE original_transaction_id = ?1")
      .bind(t.originalTransactionId).first<Row>();
    if (!row && !claim) return null;
    if (row && row.environment !== t.environment) throw claim ? badPurchase() : invalidNotification();
    let owner = row?.user_id ?? null;
    let token = row?.app_account_token ?? sent;
    if (claim && owner !== claim.id) {
      // Only a newer purchase made for this account moves a subscription to it, such as one
      // bought again on the same Apple Account after another UrBudget account's lapsed.
      if (row && !(sent && t.purchaseDate > row.purchased_at)) throw otherAccount();
      owner = claim.id;
      token = sent;
    }
    const state = merge(row, t, renewal);
    const result = entitlement(state);
    const at = now();
    const revision = (row?.revision ?? 0) + 1;
    const statements = [env.DB.prepare(`INSERT INTO apple_subscriptions (original_transaction_id, user_id, app_account_token,
        environment, transaction_id, purchased_at, signed_at, expires_at, revoked_at, auto_renew, billing_retry, grace_until,
        renewal_signed_at, revision, checked_at, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14, ?14
      WHERE (?2 IS NULL AND ?15 > 0) OR (EXISTS (SELECT 1 FROM users WHERE id = ?2)
        AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE user_id = ?2))
      ON CONFLICT(original_transaction_id) DO UPDATE SET user_id = ?2, app_account_token = ?3, transaction_id = ?5,
        purchased_at = ?6, signed_at = ?7, expires_at = ?8, revoked_at = ?9, auto_renew = ?10, billing_retry = ?11,
        grace_until = ?12, renewal_signed_at = ?13, revision = revision + 1, checked_at = ?14
      WHERE revision = ?15`)
      .bind(t.originalTransactionId, owner, token, t.environment, state.transaction_id, state.purchased_at, state.signed_at,
        state.expires_at, state.revoked_at, state.auto_renew, state.billing_retry, state.grace_until, state.renewal_signed_at,
        at, revision - 1)];
    // In the same transaction, and only if the row above was written as read: a concurrent
    // delivery must not leave the entitlement of older data behind.
    if (owner) statements.push(env.DB.prepare(`INSERT INTO subscriptions (id, user_id, customer_id, status, current_period_end,
        cancel_at, updated_at, event_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
      WHERE EXISTS (SELECT 1 FROM apple_subscriptions WHERE original_transaction_id = ?8 AND revision = ?9 AND user_id = ?2)
      ON CONFLICT(id) DO UPDATE SET user_id = ?2, customer_id = ?3, status = ?4, current_period_end = ?5, cancel_at = ?6,
        updated_at = ?7, event_at = ?7
      WHERE EXISTS (SELECT 1 FROM apple_subscriptions WHERE original_transaction_id = ?8 AND revision = ?9 AND user_id = ?2)`)
      .bind(`apple:${t.originalTransactionId}`, owner, `apple:${owner}`, result.status, result.periodEnd, result.cancelAt, at,
        t.originalTransactionId, revision));
    const [written] = await env.DB.batch(statements);
    if (written.meta.changes) return { active: SYNC_STATUSES.includes(result.status) };
    if (claim && await env.DB.prepare("SELECT 1 FROM account_deletions WHERE user_id = ?1").bind(claim.id).first())
      throw new ApiError(409, "account_deleting", "Account deletion is in progress. Try again after it finishes.");
  }
  throw new ApiError(503, "purchase_busy", "The App Store purchase couldn't be saved just now. Try again in a minute.");
}

/** Ends access whose paid or grace period has passed, in case no notification arrives in time. */
export async function settleAppleSubscriptions(env: Env, userId?: string) {
  const rows = await env.DB.prepare(`SELECT a.* FROM apple_subscriptions a
    JOIN subscriptions s ON s.id = 'apple:' || a.original_transaction_id AND s.user_id = a.user_id
    WHERE (?1 IS NULL OR a.user_id = ?1) AND s.status IN ('active', 'past_due') AND s.current_period_end <= ?2 LIMIT 100`)
    .bind(userId ?? null, now()).all<Row>();
  for (const row of rows.results) {
    const result = entitlement(row);
    await env.DB.prepare(`UPDATE subscriptions SET status = ?2, current_period_end = ?3, cancel_at = ?4, updated_at = ?5
      WHERE id = ?1 AND EXISTS (SELECT 1 FROM apple_subscriptions WHERE original_transaction_id = ?6 AND revision = ?7)`)
      .bind(`apple:${row.original_transaction_id}`, result.status, result.periodEnd, result.cancelAt, now(),
        row.original_transaction_id, row.revision).run();
  }
}

/** A JSON object body of at most `limit` bytes. */
async function body(request: Request, limit: number, fail: () => ApiError): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw fail();
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > limit) { await reader.cancel(); throw new ApiError(413, "too_large", "The request is too large."); }
    parts.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
}

export const appleBilling = new Hono<AppEnv>();
appleBilling.use("*", requireUser);
/** What the app needs before a purchase: the token to bind it to this account, and the product. */
appleBilling.get("/context", async (c) =>
  c.json({ appAccountToken: await appAccountToken(c.get("user").id), productId: APP_STORE_SYNC }));
/** A StoreKit 2 transaction (its JWS) after a purchase, a restore or a background update. */
appleBilling.post("/verify", async (c) => {
  const user = c.get("user");
  await rateLimit(c.env.DB, `apple:${user.id}`, 240, 3600);
  const transaction = await appTransaction((await body(c.req.raw, 32_768, badPurchase)).transaction);
  if (!transaction || !isSync(transaction)) throw badPurchase();
  return c.json(await record(c.env, transaction, null, user));
});

// App Store Server Notifications V2. Apple retries anything but a 200 for three days, so a
// temporary failure answers 5xx and every handler is idempotent.
export const appleNotifications = new Hono<AppEnv>();
appleNotifications.post("/", async (c) => {
  const payload = await verifyAppleJws((await body(c.req.raw, 131_072, invalidNotification)).signedPayload);
  if (!payload || typeof payload.notificationType !== "string") throw invalidNotification();
  const data = payload.data as Record<string, unknown> | undefined;
  // Summaries (of a renewal date extension for many subscribers) name no single subscription.
  if (!data || typeof data !== "object") return c.body(null, 200);
  if (data.bundleId !== APP_STORE_BUNDLE || !ENVIRONMENTS.includes(String(data.environment)) ||
      (data.environment === "Production" && data.appAppleId !== APP_STORE_APP_ID)) throw invalidNotification();
  // TEST notifications carry no transaction.
  if (data.signedTransactionInfo === undefined) return c.body(null, 200);
  const transaction = await appTransaction(data.signedTransactionInfo);
  if (!transaction || transaction.environment !== data.environment) throw invalidNotification();
  if (!isSync(transaction)) return c.body(null, 200);
  await record(c.env, transaction, await renewalInfo(data.signedRenewalInfo, transaction));
  return c.body(null, 200);
});
