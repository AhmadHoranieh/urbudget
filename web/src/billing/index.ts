// Payments: checkout, the customer portal and what webhooks change here. The provider itself
// (Polar) sits behind ./provider.ts, so this file doesn't know which one it is.
import { Hono } from "hono";
import { requireUser } from "../auth";
import type { AppEnv, Env } from "../env";
import { ApiError, countEvent, jsonBody, now, randomId, recordProblem } from "../util";
import { polar } from "./polar";
import { COMPLIMENTARY, type BillingEvent } from "./provider";
import { cancelGoogleSubscriptions, PLAY_PACKAGE } from "./google";

export { SYNC_STATUSES } from "./provider";
export const provider = polar;

/** Links a provider customer to an account, unless either is already linked elsewhere. */
async function rememberCustomer(env: Env, userId: string, customerId: string) {
  await env.DB.prepare(
    `UPDATE users SET billing_customer_id = ?2
     WHERE id = ?1 AND billing_customer_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM users WHERE billing_customer_id = ?2)`,
  )
    .bind(userId, customerId)
    .run();
}

/** The account an event belongs to: the one the checkout was opened for, else its email's. */
async function accountFor(env: Env, userId: string | null, customerId: string, email: string | null) {
  if (userId) {
    const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?1").bind(userId).first<{ id: string; email: string }>();
    if (user) return user;
    // A checkout's explicit owner no longer exists. Never recreate that identity
    // from a delayed callback after account deletion.
    return null;
  }
  const known = await env.DB.prepare("SELECT id, email FROM users WHERE billing_customer_id = ?1")
    .bind(customerId)
    .first<{ id: string; email: string }>();
  if (known) return known;
  if (!email) return null;
  // The deletion guard belongs inside the write so a concurrent deletion cannot
  // slip between a separate tombstone lookup and account creation.
  return env.DB.prepare(
    `INSERT INTO users (id, email, created_at)
     SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM deleted_billing_customers WHERE customer_id = ?4)
     ON CONFLICT(email) DO UPDATE SET email = excluded.email
     RETURNING id, email`,
  ).bind(randomId("usr"), email, now(), customerId).first<{ id: string; email: string }>();
}

/** Mirrors a Sync subscription change onto its account. */
async function apply(env: Env, event: BillingEvent) {
  const existing = await env.DB.prepare("SELECT user_id, event_at FROM subscriptions WHERE id = ?1")
    .bind(event.subscriptionId)
    .first<{ user_id: string | null; event_at: string }>();
  // Deliveries can arrive out of order; an older one must not undo a newer state.
  if (existing && existing.event_at > event.at) return;
  const owner = existing?.user_id
    ? { id: existing.user_id }
    : await accountFor(env, event.userId, event.customerId, event.email);
  const deletedOwner = !owner && (event.userId !== null || Boolean(await env.DB.prepare(
    "SELECT 1 FROM deleted_billing_customers WHERE customer_id = ?1",
  ).bind(event.customerId).first()));
  let status = event.status;
  if (deletedOwner && !["canceled", "incomplete_expired"].includes(status)) {
    // A checkout opened before deletion can complete afterwards. A failed
    // cancellation fails this webhook so the provider retries it durably.
    await provider.cancelSubscription(env, event.subscriptionId);
    status = "canceled";
  }
  if (owner) await rememberCustomer(env, owner.id, event.customerId);
  const saved = await env.DB.prepare(
    `INSERT INTO subscriptions (id, user_id, customer_id, status, current_period_end, cancel_at, updated_at, event_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
     WHERE ?2 IS NULL OR (EXISTS (SELECT 1 FROM users WHERE id = ?2)
       AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE user_id = ?2))
     ON CONFLICT(id) DO UPDATE SET user_id = ?2, customer_id = ?3, status = ?4, current_period_end = ?5,
       cancel_at = ?6, updated_at = ?7, event_at = ?8
     WHERE excluded.event_at >= subscriptions.event_at
       AND (?2 IS NULL OR (EXISTS (SELECT 1 FROM users WHERE id = ?2)
         AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE user_id = ?2)))`,
  )
    .bind(
      event.subscriptionId,
      owner?.id ?? null,
      event.customerId,
      status,
      event.currentPeriodEnd,
      event.cancelAt,
      now(),
      event.at,
    )
    .run();
  if (!saved.meta.changes && owner && !await env.DB.prepare(`SELECT 1 FROM users WHERE id = ?1
      AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE user_id = ?1)`).bind(owner.id).first())
    throw new ApiError(503, "account_deleting", "Account deletion is in progress. Retry this billing update.");
}

/** Ends a user's live sync subscriptions right away (their account is being deleted). */
export async function cancelSubscriptions(env: Env, userId: string) {
  await cancelGoogleSubscriptions(env, userId);
  const live = await env.DB.prepare(
    `SELECT id FROM subscriptions WHERE user_id = ?1 AND status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused')`,
  )
    .bind(userId)
    .all<{ id: string }>();
  for (const { id } of live.results)
    if (!id.startsWith("google:") && !id.startsWith(COMPLIMENTARY)) await provider.cancelSubscription(env, id);
}

export const billing = new Hono<AppEnv>();

/** A checkout page for the Sync plan, tied to the signed-in account; the browser goes there next. */
billing.post("/checkout", requireUser, async (c) => {
  const body = await jsonBody(c.req.raw);
  // Sync is the only plan; `plan` may be left out.
  if (body.plan !== undefined && body.plan !== "sync") throw new ApiError(400, "invalid_plan", "Sync is the only plan to buy.");
  const user = c.get("user");
  if (await c.env.DB.prepare("SELECT 1 FROM account_deletions WHERE user_id = ?1").bind(user.id).first())
    throw new ApiError(409, "account_deleting", "Account deletion is in progress. Try again after it finishes.");
  const site = c.env.APP_URL.replace(/\/+$/, "");
  const url = await provider.createCheckout(c.env, {
    user: { id: user.id, email: user.email },
    successUrl: `${site}/account/?checkout_id={CHECKOUT_ID}`,
    returnUrl: `${site}/account/`,
  });
  await countEvent(c.env.DB, "checkout", "sync");
  return c.json({ url });
});

billing.post("/portal", requireUser, async (c) => {
  const user = c.get("user");
  const subscription = await c.env.DB.prepare(
    `SELECT id, customer_id FROM subscriptions WHERE user_id = ?1
     ORDER BY (status IN ('active', 'trialing', 'past_due')) DESC, updated_at DESC LIMIT 1`,
  ).bind(user.id).first<{ id: string; customer_id: string }>();
  if (subscription?.id.startsWith("google:"))
    return c.json({ url: `https://play.google.com/store/account/subscriptions?package=${PLAY_PACKAGE}` });
  if (subscription?.id.startsWith(COMPLIMENTARY))
    throw new ApiError(404, "no_customer", "This account's Sync was given by UrBudget, so there's nothing to manage.");
  const customerId =
    subscription?.customer_id ?? user.billing_customer_id ??
    null;
  if (!customerId)
    throw new ApiError(404, "no_customer", "There's nothing to manage yet: this account hasn't subscribed to Sync.");
  const url = await provider.portalUrl(c.env, { userId: user.id, customerId }, `${c.env.APP_URL.replace(/\/+$/, "")}/account/`);
  return c.json({ url });
});

billing.post("/webhook", async (c) => {
  const body = await c.req.text();
  const webhook = await provider.readWebhook(c.env, c.req.raw, body);
  if (!webhook) {
    // A wrong secret stops every purchase from arriving, so it's noted; scanners rarely send this header.
    const delivery = c.req.header("webhook-id");
    if (delivery)
      await recordProblem(c.env.DB, "webhook", "bad signature", `Delivery ${delivery.slice(0, 80)} didn't match the webhook secret.`);
    throw new ApiError(401, "bad_signature", "The webhook signature didn't match.");
  }
  const seen = await c.env.DB.prepare("SELECT 1 FROM webhook_events WHERE id = ?1").bind(webhook.id).first();
  if (seen) return c.json({ ok: true });
  try {
    for (const event of webhook.events) await apply(c.env, event);
  } catch (error) {
    await recordProblem(c.env.DB, "webhook", webhook.type, `Delivery ${webhook.id}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  // Recorded after handling, so a failure is retried by the provider; every handler is idempotent.
  await c.env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id, type, received_at) VALUES (?1, ?2, ?3)")
    .bind(webhook.id, webhook.type, now())
    .run();
  return c.json({ ok: true });
});
