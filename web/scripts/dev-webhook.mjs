// Pretends to be Polar against `npm run dev`, so Sync can be tried without a checkout.
//   node scripts/dev-webhook.mjs subscribe <email>          the $3/month Sync plan starts
//   node scripts/dev-webhook.mjs cancel <email>             the Sync plan ends
// Signs events (Standard Webhooks) with POLAR_WEBHOOK_SECRET from .dev.vars; needs
// DEV_LOGIN_CODES=1 there.
import { readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";

const [action, email] = process.argv.slice(2);
if (!["subscribe", "cancel"].includes(action) || !email) {
  console.error("Usage: node scripts/dev-webhook.mjs subscribe|cancel <email>");
  process.exit(1);
}
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = vars.APP_URL ?? "http://localhost:8787";
const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const { devCode } = await post("/api/v1/auth/start", { email });
const { user } = await post("/api/v1/auth/verify", { email, code: devCode, client: "web" });

const customer = { email, external_id: user.id };
const customerId = `cus_dev_${user.id.slice(4)}`;
const now = new Date().toISOString();
const subscription = (status, extra = {}) => ({
  id: `sub_dev_${user.id.slice(4)}`,
  status,
  customer_id: customerId,
  customer,
  product_id: vars.POLAR_PRODUCT_SYNC,
  current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  cancel_at_period_end: false,
  ends_at: null,
  ended_at: null,
  metadata: { plan: "sync", user_id: user.id },
  modified_at: now,
  ...extra,
});
const [type, data] = {
  subscribe: ["subscription.active", subscription("active")],
  cancel: ["subscription.revoked", subscription("canceled", { ended_at: now })],
}[action];

const body = JSON.stringify({ type, timestamp: now, data });
const id = `msg_${randomBytes(12).toString("hex")}`;
const ts = Math.floor(Date.now() / 1000);
const key = Buffer.from(vars.POLAR_WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64");
const signature = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
const response = await fetch(`${base}/api/v1/billing/webhook`, {
  method: "POST",
  headers: { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${signature}` },
  body,
});
console.log(response.status, await response.text());
