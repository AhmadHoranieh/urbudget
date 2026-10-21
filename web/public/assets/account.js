// /account/: email sign-in with a 6-digit code, then the account's Sync subscription and
// account deletion. The session is an HttpOnly cookie, so whether someone is
// signed in is only known from GET /api/v1/me (401 = signed out).
//
// ?subscribe=1 opens the Sync checkout once signed in (after signing in, if need be).

import { api, ApiError, getMe, sleep } from "./api.js";
import { startCheckout } from "./checkout.js";
import { dropParams, formatBytes, formatDate, params, setStatus } from "./site.js?v=2";

const $ = (id) => document.getElementById(id);

const els = {
  loading: $("account-loading"),
  error: $("account-error"),
  errorText: $("account-error-text"),
  retry: $("account-retry"),
  signin: $("signin"),
  subscribeHint: $("subscribe-hint"),
  emailForm: $("email-form"),
  email: $("email"),
  emailSubmit: $("email-submit"),
  codeForm: $("code-form"),
  code: $("code"),
  codeEmail: $("code-email"),
  codeSubmit: $("code-submit"),
  devHint: $("dev-code-hint"),
  devCode: $("dev-code"),
  changeEmail: $("change-email"),
  resend: $("resend-code"),
  signinStatus: $("signin-status"),
  dashboard: $("dashboard"),
  accountEmail: $("account-email"),
  accountSince: $("account-since"),
  signout: $("signout"),
  accountStatus: $("account-status"),
  syncBadge: $("sync-badge"),
  syncSummary: $("sync-summary"),
  syncUsage: $("sync-usage"),
  manage: $("manage-sub"),
  subscribe: $("subscribe"),
  syncSuccess: $("sync-success"),
  syncStatus: $("sync-status"),
  deleteForm: $("delete-form"),
  deleteConfirm: $("delete-confirm"),
  deleteSubmit: $("delete-submit"),
  deleteStatus: $("delete-status"),
  deleteZone: $("delete-zone"),
};

let me = null;
let pendingEmail = "";
let wantsSubscribe = params.get("subscribe") === "1";
// Polar sends subscribers back here with ?checkout_id=… once they've paid.
const returnedFromCheckout = /^[\w-]{8,80}$/.test(params.get("checkout_id") || "");

/* ---------- Views ---------- */

function showLoading() {
  els.loading.hidden = false;
  els.signin.hidden = true;
  els.dashboard.hidden = true;
  els.error.hidden = true;
}

/** The header's "Sign in" link reads "Account" while signed in. */
function headerLink(signedIn) {
  const link = document.querySelector(".header-signin");
  if (link) link.textContent = signedIn ? "Account" : "Sign in";
}

function showSignin(message = "", kind = "") {
  me = null;
  headerLink(false);
  els.loading.hidden = true;
  els.dashboard.hidden = true;
  els.signin.hidden = false;
  els.subscribeHint.hidden = !wantsSubscribe;
  showEmailStep();
  setStatus(els.signinStatus, message, kind);
}

function showEmailStep() {
  els.emailForm.hidden = false;
  els.codeForm.hidden = true;
  els.devHint.hidden = true;
  els.code.value = "";
}

function showCodeStep(email, devCode) {
  els.emailForm.hidden = true;
  els.codeForm.hidden = false;
  els.codeEmail.textContent = email;
  if (devCode) {
    els.code.value = String(devCode);
    els.devCode.textContent = String(devCode);
    els.devHint.hidden = false;
  } else {
    els.code.value = "";
    els.devHint.hidden = true;
  }
  els.code.focus();
}

function showError(message) {
  els.errorText.textContent = message;
  els.error.hidden = false;
}

/* ---------- Account ---------- */

async function loadAccount() {
  showLoading();
  try {
    me = await getMe();
  } catch (error) {
    // The API is unreachable: still offer the sign-in form, with the reason above it.
    showSignin();
    showError(error.message);
    return;
  }
  if (!me) {
    showSignin();
    return;
  }
  renderAccount();
  if (returnedFromCheckout) {
    dropParams("checkout_id");
    if (!syncRunning(me.subscription)) void waitForSync();
    else showSyncOn();
    return;
  }
  if (wantsSubscribe) {
    wantsSubscribe = false;
    dropParams("subscribe");
    if (syncRunning(me.subscription)) {
      setStatus(els.syncStatus, "Sync is already on for this account.");
    } else {
      void startSubscribe();
    }
  }
}

function renderAccount() {
  headerLink(true);
  els.loading.hidden = true;
  els.signin.hidden = true;
  els.error.hidden = true;
  els.dashboard.hidden = false;
  els.accountEmail.textContent = me.user.email;
  const since = formatDate(me.user.createdAt);
  els.accountSince.textContent = since ? `Account created ${since}.` : "";
  renderSync();
  els.deleteConfirm.value = "";
  els.deleteSubmit.disabled = true;
}

/** Sync works while the subscription is active, trialing or past due. */
const syncRunning = (sub) => Boolean(sub && ["active", "trialing", "past_due"].includes(sub.status));

function setBadge(text, tone) {
  els.syncBadge.textContent = text;
  els.syncBadge.className = `badge ${tone}`;
  els.syncBadge.hidden = !text;
}

function renderSync() {
  const sub = me.subscription;
  const renews = formatDate(sub?.renewsAt);
  const ends = formatDate(sub?.endsAt);
  let summary = "";
  let canManage = Boolean(sub);
  let canSubscribe = false;

  if (!sub) {
    setBadge("Off", "");
    summary =
      "Keep your budgets in step across your computers, end-to-end encrypted, for $3 a month. Cancel anytime; your budgets stay on your computers either way.";
    canSubscribe = true;
  } else if (sub.status === "active" || sub.status === "trialing") {
    if (ends) {
      setBadge("Ending", "badge-warn");
      summary = `Sync is on until ${ends}. It won't renew after that.`;
    } else {
      setBadge(sub.status === "trialing" ? "Trial" : "Active", "badge-success");
      summary = renews ? `Sync is on. Your subscription renews on ${renews}.` : "Sync is on.";
    }
  } else if (sub.status === "past_due") {
    setBadge("Past due", "badge-warn");
    summary =
      "Your last payment didn't go through. Sync keeps working for now; update your payment method under Manage subscription to keep it on.";
  } else if (sub.status === "paused") {
    setBadge("Paused", "");
    summary = "Your subscription is paused, so sync is off. Resume it under Manage subscription.";
  } else {
    setBadge("Ended", "");
    summary = ends ? `Your subscription ended on ${ends}.` : "Your subscription has ended.";
    canSubscribe = true;
  }

  els.syncSummary.textContent = summary;
  els.manage.hidden = !canManage;
  els.manage.textContent = sub?.provider === "google" ? "Manage in Google Play" : "Manage subscription";
  els.subscribe.hidden = !canSubscribe;
  els.subscribe.querySelector("[data-label]").textContent =
    sub && sub.status === "canceled" ? "Subscribe again" : "Subscribe";

  const budgets = Number(me.sync?.budgets) || 0;
  if (budgets > 0) {
    const size = formatBytes(me.sync?.bytes);
    els.syncUsage.textContent = `${budgets} ${budgets === 1 ? "budget" : "budgets"} synced${size ? ` · ${size} encrypted` : ""}.`;
    els.syncUsage.hidden = false;
  } else {
    els.syncUsage.hidden = true;
  }
}

/* ---------- Sign in ---------- */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendCode(email) {
  setStatus(els.signinStatus, "Sending your code…");
  els.emailSubmit.disabled = true;
  els.resend.disabled = true;
  try {
    const result = await api("/auth/start", { method: "POST", body: { email } });
    pendingEmail = email;
    showCodeStep(email, result.devCode);
    setStatus(els.signinStatus, `We emailed a 6-digit code to ${email}. It can take a minute to arrive; if it doesn't, check your Junk or Spam folder.`);
  } catch (error) {
    setStatus(els.signinStatus, error.message, "error");
  } finally {
    els.emailSubmit.disabled = false;
    els.resend.disabled = false;
  }
}

els.emailForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = els.email.value.trim();
  if (!EMAIL.test(email)) {
    setStatus(els.signinStatus, "Please enter a valid email address.", "error");
    els.email.focus();
    return;
  }
  void sendCode(email);
});

async function verify() {
  const code = els.code.value.replace(/\D/g, "");
  if (code.length !== 6) {
    setStatus(els.signinStatus, "The code has 6 digits.", "error");
    els.code.focus();
    return;
  }
  setStatus(els.signinStatus, "Signing in…");
  els.codeSubmit.disabled = true;
  try {
    await api("/auth/verify", { method: "POST", body: { email: pendingEmail, code, client: "web" } });
    setStatus(els.signinStatus, "");
    await loadAccount();
    if (!els.dashboard.hidden) $("dashboard-title")?.focus();
  } catch (error) {
    const hint =
      error instanceof ApiError && (error.code === "expired_code" || error.code === "too_many_attempts")
        ? " Choose “Send a new code” to get another."
        : "";
    setStatus(els.signinStatus, error.message + hint, "error");
    els.code.select();
  } finally {
    els.codeSubmit.disabled = false;
  }
}

els.codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void verify();
});
els.code.addEventListener("input", (event) => {
  const digits = els.code.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== els.code.value) els.code.value = digits;
  // Typing or pasting the last digit signs in; a code filled in for local development doesn't.
  if (digits.length === 6 && event.isTrusted && !els.codeSubmit.disabled) void verify();
});
els.changeEmail.addEventListener("click", () => {
  showEmailStep();
  setStatus(els.signinStatus, "");
  els.email.focus();
});
els.resend.addEventListener("click", () => {
  if (pendingEmail) void sendCode(pendingEmail);
});

els.signout.addEventListener("click", async () => {
  els.signout.disabled = true;
  try {
    await api("/auth/logout", { method: "POST" });
    showSignin("You're signed out.", "success");
  } catch (error) {
    setStatus(els.accountStatus, error.message, "error");
  } finally {
    els.signout.disabled = false;
  }
});

els.retry.addEventListener("click", () => void loadAccount());

/* ---------- Sync subscription ---------- */

async function startSubscribe() {
  els.subscribe.disabled = true;
  setStatus(els.syncStatus, "Opening the secure checkout…");
  const problem = await startCheckout("sync");
  els.subscribe.disabled = false;
  setStatus(els.syncStatus, problem.message, problem.kind);
}

function showSyncOn() {
  renderSync();
  setStatus(els.syncStatus, "");
  els.syncSuccess.hidden = false;
  els.syncSuccess.focus();
}

async function waitForSync() {
  els.subscribe.hidden = true;
  setStatus(els.syncStatus, "Payment received. Turning on sync…");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const fresh = await getMe();
      if (!fresh) break;
      me = fresh;
      if (fresh.sync?.active) {
        showSyncOn();
        return;
      }
    } catch {
      // Keep trying until the deadline.
    }
  }
  setStatus(
    els.syncStatus,
    "Your payment went through. Sync can take a minute to switch on; refresh this page shortly to see it.",
  );
}

els.subscribe.addEventListener("click", () => void startSubscribe());

els.manage.addEventListener("click", async () => {
  els.manage.disabled = true;
  setStatus(els.syncStatus, "Opening the subscription page…");
  try {
    const { url } = await api("/billing/portal", { method: "POST" });
    if (!url) throw new ApiError("The subscription page isn't available right now.");
    location.href = url;
  } catch (error) {
    setStatus(els.syncStatus, error.message, "error");
    els.manage.disabled = false;
  }
});

/* ---------- Delete account ---------- */

const confirmMatches = () =>
  Boolean(me) && els.deleteConfirm.value.trim().toLowerCase() === me.user.email.trim().toLowerCase();

els.deleteConfirm.addEventListener("input", () => {
  els.deleteSubmit.disabled = !confirmMatches();
});

els.deleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!confirmMatches()) {
    setStatus(els.deleteStatus, "Type your account's email address exactly to confirm.", "error");
    return;
  }
  els.deleteSubmit.disabled = true;
  setStatus(els.deleteStatus, "Deleting your account…");
  try {
    await api("/me", { method: "DELETE", body: { confirm: me.user.email } });
    els.deleteZone.open = false;
    setStatus(els.deleteStatus, "");
    showSignin("Your account and its synced data were deleted. The budgets on your computers aren't affected.", "success");
  } catch (error) {
    setStatus(els.deleteStatus, error.message, "error");
    els.deleteSubmit.disabled = !confirmMatches();
  }
});

/* ---------- Start ---------- */

void loadAccount();
