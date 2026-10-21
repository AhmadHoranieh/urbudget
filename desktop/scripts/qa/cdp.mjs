// Drives the running app through WebView2's debugging port (start it with `npm run qa`).
//   node scripts/qa/cdp.mjs shot <out.png> [width height]   screenshot (optionally at a size)
//   node scripts/qa/cdp.mjs eval <js-expression | @file.js>  run code in the window, print the result
// SCHEME=light|dark emulates the colour scheme; SIZE=1000x662 emulates a window size for eval;
// CDP_PORT overrides 9222.
import { writeFileSync, readFileSync } from "node:fs";

const [cmd, arg, w, h] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/list`)).json();
const page = pages.find((p) => p.type === "page" && p.url.includes("1420"));
if (!page) throw new Error("No UrBudget page on port 9222");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let next = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

if (process.env.SCHEME)
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: process.env.SCHEME }] });
if (cmd === "shot") {
  if (w) await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  if (w) await send("Emulation.clearDeviceMetricsOverride");
  writeFileSync(arg, Buffer.from(data, "base64"));
  console.log(`saved ${arg}`);
} else if (cmd === "eval") {
  const [sw, sh] = (process.env.SIZE ?? "").split("x").map(Number);
  if (sw) await send("Emulation.setDeviceMetricsOverride", { width: sw, height: sh, deviceScaleFactor: 1, mobile: false });
  const expression = arg.startsWith("@") ? readFileSync(arg.slice(1), "utf8") : arg;
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
  // The emulated size outlives this connection unless it is cleared.
  if (sw) await send("Emulation.clearDeviceMetricsOverride");
  if (r.exceptionDetails) console.error(JSON.stringify(r.exceptionDetails, null, 1));
  else console.log(typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value, null, 1));
}
ws.close();
