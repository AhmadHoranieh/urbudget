// What the rest of the app needs from a payment provider. Polar implements it today; another
// provider (Paddle's version is in commit 3cd665f) only has to implement this file's interface.
import type { Env } from "../env";

/** A change to a Sync subscription the provider told us about, in this app's terms. Sync is the only thing sold. */
export interface BillingEvent {
  subscriptionId: string;
  customerId: string;
  email: string | null;
  /** The account the checkout was opened for. */
  userId: string | null;
  status: string;
  currentPeriodEnd: string | null;
  /** When a cancellation takes effect, if one is scheduled or done. */
  cancelAt: string | null;
  /** When the provider made this change, to ignore deliveries that arrive late. */
  at: string;
}

/** Sales numbers over a range of days, for the admin page. */
export interface Metrics {
  /** Each metric asked for that the provider knows: its name, and how to show it (currency is in cents). */
  metrics: { slug: string; name: string; type: "scalar" | "currency" | "percentage" }[];
  totals: Record<string, number | null>;
  periods: ({ start: string } & Record<string, number | string | null>)[];
}

export interface Webhook {
  /** Unique per delivery attempt's message, so retries are recognized. */
  id: string;
  type: string;
  events: BillingEvent[];
}

export interface BillingProvider {
  /** A hosted checkout page for the Sync plan, tied to the signed-in account. */
  createCheckout(
    env: Env,
    request: { user: { id: string; email: string }; successUrl: string; returnUrl: string },
  ): Promise<string>;
  /** The provider's page where a customer updates their card or cancels. */
  portalUrl(env: Env, customer: { userId: string; customerId: string | null }, returnUrl: string): Promise<string>;
  /** Ends a subscription right away (the account is being deleted). */
  cancelSubscription(env: Env, subscriptionId: string): Promise<void>;
  /** Checks a webhook's signature and reads it; null when the signature doesn't match. */
  readWebhook(env: Env, request: Request, body: string): Promise<Webhook | null>;
  /** Revenue, orders and subscription numbers between two dates (YYYY-MM-DD, UTC), per interval. */
  metrics(env: Env, range: { start: string; end: string; interval: "day" | "week" | "month" }, slugs: string[]): Promise<Metrics>;
}

/** Subscription states in which sync works (a failed renewal is retried while past due). */
export const SYNC_STATUSES = ["active", "trialing", "past_due"];

/**
 * The id prefix of Sync that UrBudget grants itself, such as the store review account's: a row
 * added by hand (README › Google Play purchases). No provider bills, cancels or manages it.
 */
export const COMPLIMENTARY = "comp:";
