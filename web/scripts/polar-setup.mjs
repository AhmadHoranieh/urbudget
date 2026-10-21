// Connects urbudget.app to Polar and stores the Worker's secrets, in one go:
//   npm run go-live                          (polar.sh: real payments)
//   npm run polar:setup -- --sandbox         (sandbox.polar.sh, for testing)
// It asks for a Polar organization access token (Polar → Settings → Developers → Create token,
// with the products, checkouts, customer sessions, subscriptions and webhooks scopes, and
// metrics:read for the admin page's sales numbers) and,
// optionally, a Resend API key. Copying each is enough (on Windows and macOS it's picked up from the
// clipboard); pasting it into the terminal works too. Neither is shown. Then it:
//   1. creates the one product if it doesn't exist, "UrBudget Sync" ($3 a month); UrBudget itself
//      is free, so Sync is the only thing sold. An existing one at another price is moved to $3;
//   2. creates (or reuses) the webhook that tells urbudget.app about subscriptions;
//   3. writes BILLING_ENV and the product id into wrangler.jsonc;
//   4. stores the Worker secrets: the Polar token and webhook secret, and the Resend key if given;
//   5. deploys.
// Run it after the first `npm run deploy`. --url https://… points the webhook somewhere else.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const production = args.includes("--production");
if (!production && !args.includes("--sandbox")) {
  console.error("Say which Polar: npm run polar:setup -- --sandbox   or   -- --production");
  process.exit(1);
}
const urlAt = args.indexOf("--url");
const site = (urlAt >= 0 ? args[urlAt + 1] : "https://urbudget.app").replace(/\/+$/, "");
const api = production ? "https://api.polar.sh" : "https://sandbox-api.polar.sh";

/** What's on the clipboard, or "" where it can't be read. */
function clipboard() {
  try {
    if (process.platform === "win32") {
      return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    }
    if (process.platform === "darwin") return execFileSync("pbpaste", { encoding: "utf8" }).trim();
  } catch {
    // No clipboard: pasting still works.
  }
  return "";
}

/**
 * Gets a secret without showing it: it's taken from the clipboard as soon as something copied
 * contains a match for `pattern` (checked every second; other text around it is ignored), or
 * pasted here and confirmed with Enter. With `optional`, Enter on its own skips it.
 */
async function secret(question, pattern, optional = false) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    let typed = "";
    let finished = false;
    const finish = (value, how) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(value ? ` (${how})\n` : " (skipped)\n");
      resolve(value);
    };
    const onData = (chunk) => {
      // Terminals wrap a paste in ESC[200~ … ESC[201~.
      for (const ch of chunk.replace(/\u001b\[20[01]~/g, "")) {
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          const value = typed.match(pattern)?.[0] ?? "";
          const empty = !typed.trim();
          typed = "";
          if (value || (empty && optional)) return finish(value, "received");
          if (!empty) process.stdout.write("\nThat doesn't look right. Copy it again, or paste it and press Enter: ");
        } else if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else if (ch >= " ") typed += ch;
      }
    };
    const timer = setInterval(() => {
      const copied = clipboard().match(pattern)?.[0];
      if (copied) finish(copied, "taken from the clipboard");
    }, 1000);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

const token =
  process.env.POLAR_ACCESS_TOKEN ||
  (await secret(
    `Copy your Polar ${production ? "production" : "sandbox"} access token (it starts with polar_)… `,
    /\bpolar_\w+/,
  ));
const resendKey =
  process.env.RESEND_API_KEY ||
  (await secret(
    "Now copy your Resend API key (it starts with re_), or press Enter to skip; sign-in emails won't send until you add one… ",
    /\bre_\w+/,
    true,
  ));

async function polar(method, path, body) {
  const response = await fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** A monthly product at `cents` (USD): the existing one by that name, its price corrected if needed, or a new one. */
async function monthlyProduct(name, description, cents) {
  const price = { amount_type: "fixed", price_currency: "usd", price_amount: cents };
  const found = await polar("GET", `/v1/products/?query=${encodeURIComponent(name)}&is_archived=false&limit=100`);
  const existing = found.items?.find((p) => p.name === name);
  if (existing) {
    const current = existing.prices?.filter((p) => !p.is_archived) ?? [];
    const right = current.length === 1 && current[0].amount_type === "fixed" && current[0].price_currency === "usd" &&
      current[0].price_amount === cents;
    if (right) {
      console.log(`Using the existing product "${name}" (${existing.id}).`);
    } else {
      // Prices left out of the list are archived; new subscriptions get this one.
      await polar("PATCH", `/v1/products/${existing.id}`, { prices: [price] });
      console.log(`Set the existing product "${name}" (${existing.id}) to $${(cents / 100).toFixed(2)} a month.`);
    }
    return existing.id;
  }
  const created = await polar("POST", "/v1/products/", {
    name,
    description,
    visibility: "public",
    recurring_interval: "month",
    recurring_interval_count: 1,
    prices: [price],
  });
  console.log(`Created "${name}" (${created.id}).`);
  return created.id;
}

const sync = await monthlyProduct(
  "UrBudget Sync",
  "End-to-end encrypted sync of your UrBudget budgets between your devices.",
  300,
);

const webhookUrl = `${site}/api/v1/billing/webhook`;
const existing = (await polar("GET", "/v1/webhooks/endpoints?limit=100")).items?.find((e) => e.url === webhookUrl);
const endpoint = existing ?? await polar("POST", "/v1/webhooks/endpoints", {
  url: webhookUrl,
  name: "urbudget.app",
  format: "raw",
  api_version: "2026-04",
  events: [
    "subscription.created",
    "subscription.active",
    "subscription.updated",
    "subscription.canceled",
    "subscription.uncanceled",
    "subscription.revoked",
    "subscription.past_due",
  ],
});
console.log(`${existing ? "Using the existing" : "Created the"} webhook to ${endpoint.url}.`);
if (!endpoint.secret) throw new Error("Polar didn't return the webhook's signing secret.");

const config = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
let text = readFileSync(config, "utf8");
const setVar = (name, value) => {
  const pattern = new RegExp(`("${name}":\\s*)"[^"]*"`);
  if (!pattern.test(text)) throw new Error(`wrangler.jsonc has no ${name}`);
  text = text.replace(pattern, `$1"${value}"`);
};
setVar("BILLING_ENV", production ? "production" : "sandbox");
setVar("POLAR_PRODUCT_SYNC", sync);
writeFileSync(config, text);
console.log("Wrote BILLING_ENV and the product id into wrangler.jsonc.");

const putSecret = (name, value) => {
  try {
    execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "secret", "put", name], {
      input: value,
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    return true;
  } catch {
    return false;
  }
};
const secrets = { POLAR_ACCESS_TOKEN: token, POLAR_WEBHOOK_SECRET: endpoint.secret };
if (resendKey) secrets.RESEND_API_KEY = resendKey;
const failed = Object.entries(secrets)
  .filter(([name, value]) => {
    console.log(`Storing ${name}…`);
    return !putSecret(name, value);
  })
  .map(([name]) => name);
if (failed.length) {
  console.log(`\nCouldn't store ${failed.join(", ")}. Is \`npx wrangler login\` done and the Worker deployed?`);
  console.log("Store each with:  npx wrangler secret put NAME");
  process.exit(1);
}
console.log("\nDeploying…");
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "deploy"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
console.log(`\nDone. Polar is connected to ${site}.`);
