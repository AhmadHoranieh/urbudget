// Checkout happens on Polar's hosted page: the API creates a checkout session (tied to the
// account when signed in) and the browser goes there. Polar sends people back to
// /account/?checkout_id=… once they've paid.
//
//   const problem = await startCheckout("sync");   // navigates away, or returns a message

import { api } from "./api.js";

export const NOT_CONFIGURED = "Checkout isn't available yet. Please check back soon, or write to support@urbudget.app.";

/**
 * Goes to the checkout for "sync". Resolves only when it couldn't, with the reason
 * to show (the page stays put).
 * @returns {Promise<{ message: string, kind: "" | "error", code?: string }>}
 */
export async function startCheckout(plan) {
  try {
    const { url } = await api("/billing/checkout", { method: "POST", body: { plan } });
    if (!url) throw new Error("No checkout address came back.");
    location.assign(url);
    // Keep the "opening" state while the browser leaves.
    return new Promise(() => {});
  } catch (error) {
    if (error?.code === "not_configured") return { message: NOT_CONFIGURED, kind: "", code: error.code };
    return { message: error?.message || "The checkout couldn't be opened. Try again in a minute.", kind: "error", code: error?.code };
  }
}
