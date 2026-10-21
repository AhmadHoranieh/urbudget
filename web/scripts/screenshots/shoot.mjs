// Captures the website's screenshots from the running app, light and dark, at 2x.
// The tour's pictures and the reports widget's fallback; the reports themselves are drawn live
// on the page by public/assets/reports.js.
//   1. node web/scripts/screenshots/make-showcase-budget.mjs
//   2. From desktop/, start the app on that budget with a debugging port:
//        LOCAL_BUDGET_DATA_DIR=<repo>/migration-showcase WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run desktop
//   3. node web/scripts/screenshots/shoot.mjs web/screenshots
//   4. From web/: npm run images
// Optional second argument: a JSON list of steps, e.g. '[{"click":["Reports","Net worth"],"shot":"networth"}]'.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { connect } from "./cdp.mjs";
const out = process.argv[2] ?? "web/screenshots";
mkdirSync(out, { recursive: true });
const client = await connect();
const { send, evaluate } = client;
const captures = [];
const previousTheme = await evaluate("document.documentElement.dataset.theme ?? null");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function click(label) {
  return evaluate(`(() => { const el = [...document.querySelectorAll("nav a, nav button, aside a, aside button, button, a, [role=tab], li")].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)})); if (!el) throw new Error("Screenshot navigation missing: " + ${JSON.stringify(label)}); el.click(); return "ok"; })()`);
}
// Full desktop captures are 1280×800 at 2×. The website generator makes its feature crops.
// Preserve the actual app UI.
async function shot(name, scheme, w = 1280, h = 800) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await evaluate(`document.documentElement.dataset.theme = "${scheme}"`);
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await wait(900);
  await evaluate("document.fonts.ready.then(() => true)");
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}/${name}-${scheme}.png`, Buffer.from(data, "base64"));
  const rendered = await evaluate("({title:document.title,text:document.body.innerText.slice(0,1200),scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth})");
  if (rendered.scrollWidth > rendered.viewport) throw new Error(`Horizontal overflow in ${name}`);
  captures.push({ file: `${name}-${scheme}.png`, width: w * 2, height: h * 2, theme: scheme, sha256: createHash("sha256").update(Buffer.from(data,"base64")).digest("hex"), rendered });
  console.log("saved", name, scheme);
}
// The car loan's payoff planner: its details added from its register, as someone would, and an
// extra $150 a month tried, so the picture shows the payoff comparison.
const LOAN_PLANNER = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const button = (text) => [...document.querySelectorAll("button")].find((b) => b.innerText.trim().startsWith(text));
  const field = (label) => document.querySelector(\`[aria-label="\${label}"]\`);
  const set = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const add = button("Add loan details");
  if (add) {
    add.click();
    await sleep(600);
    set(field("Interest rate"), "4.9");
    set(field("Monthly payment"), "750");
    const category = field("Payment category");
    category.focus();
    set(category, "Car loan payment");
    await sleep(400);
    const option = [...document.querySelectorAll("[role=option]")].find((o) => o.innerText.trim().startsWith("Car loan payment"));
    option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    option?.click();
    await sleep(300);
    button("Update account").click();
    await sleep(1200);
  }
  const planner = button("Payoff planner");
  if (!planner) throw new Error("Screenshot navigation missing: Payoff planner");
  planner.click();
  await sleep(800);
  set(field("Extra each month"), "150");
  await sleep(1500);
  document.activeElement?.blur();
  return "loan planner open";
})()`;
const steps = JSON.parse(
  process.argv[3] ??
    JSON.stringify([
      { click: "Budget", wait: 2000, shot: "budget", w: 1280, h: 800 },
      { click: "All transactions", shot: "register" },
      { click: ["Reports", "Spending", "By category"], wait: 2500, shot: "reports", w: 1280, h: 800 },
      { click: "Car loan", wait: 2000, eval: LOAN_PLANNER, shot: "loans" },
      { eval: `document.querySelector('[role="dialog"] button[aria-label="Close dialog"]')?.click()` },
      { click: "Budget", wait: 1000 },
    ]),
);
try {
  for (const s of steps) {
    // Set the viewport before navigation, so dialogs and virtual lists lay out for the capture.
    await send("Emulation.setDeviceMetricsOverride", { width: s.w ?? 1280, height: s.h ?? 800, deviceScaleFactor: 2, mobile: false });
    if (s.click) { for (const c of [].concat(s.click)) { console.log(c, await click(c)); await wait(s.wait ?? 1200); } }
    if (s.eval) console.log(await evaluate(s.eval));
    if (s.shot) for (const scheme of s.schemes ?? ["light", "dark"]) await shot(s.shot, scheme, s.w, s.h);
  }
  writeFileSync(out + "/provenance.json", JSON.stringify({ capturedAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim(), appVersion: await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:app|version')"), fixture: "synthetic showcase budget", captures }, null, 2) + "\n");
} finally {
  try {
    await send("Emulation.clearDeviceMetricsOverride");
    await send("Emulation.setEmulatedMedia", { features: [] });
    await evaluate(previousTheme === null ? "delete document.documentElement.dataset.theme" : "document.documentElement.dataset.theme = " + JSON.stringify(previousTheme));
  } finally {
    client.close();
  }
}
