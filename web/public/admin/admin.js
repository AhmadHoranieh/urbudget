// /admin/: accounts and the numbers behind UrBudget. Cloudflare Access signs the admin in before
// this page loads, and the API checks again on every call. Values from the server (emails, notes,
// sources) are untrusted, so every one goes into the page as text, never as HTML.

import { api, ApiError } from "/assets/api.js";
import { copyText, formatBytes, setStatus } from "/assets/site.js";

const $ = (id) => document.getElementById(id);

/* ---------- Building the page ---------- */

/** An element with attributes and children (strings become text nodes): h("td", { class: "num" }, 3) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith("on")) el.addEventListener(name.slice(2), value);
    else el.setAttribute(name === "className" ? "class" : name, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

/** Fills a table body; `empty` is shown in one row when there's nothing. */
function fillTable(table, rows, empty) {
  const body = table.tBodies[0];
  const columns = table.tHead?.rows[0]?.cells.length || 1;
  body.replaceChildren(...(rows.length ? rows : [h("tr", { class: "empty" }, h("td", { colspan: columns }, empty))]));
}

/* ---------- Formatting ---------- */

const numberFormat = new Intl.NumberFormat("en-US");
const num = (n) => numberFormat.format(Number(n) || 0);
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const money = (cents) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.round(cents) % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format((Number(cents) || 0) / 100);
const percent = (ratio) => `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.1 ? 1 : 0)}%`;
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

const thisYear = new Date().getFullYear();
/** "Oct 17, 2:05 PM" (with the year when it isn't this one), in this computer's time zone. */
function when(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === thisYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
/** "Oct 17, 2026" from a timestamp or a YYYY-MM-DD day (read as UTC). */
function dateOnly(iso) {
  if (!iso) return "";
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
/** "Oct 17" for a chart axis. */
const shortDay = (day) => new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const sum = (values) => values.reduce((total, v) => total + (Number(v) || 0), 0);

function badge(text, kind = "") {
  return h("span", { class: `badge${kind ? ` badge-${kind}` : ""}` }, text);
}

/* ---------- Stat tiles ---------- */

/** "↑ 25% more than the 30 days before", or nothing when both periods had none. */
function trend([now, before]) {
  if (!now && !before) return null;
  const title = `${num(now)} in the last 30 days, ${num(before)} in the 30 days before`;
  if (!before) return h("span", { class: "tile-trend is-up", title }, "New: none in the 30 days before");
  if (now === before) return h("span", { class: "tile-trend", title }, "Same as the 30 days before");
  const up = now > before;
  return h(
    "span",
    { class: `tile-trend is-${up ? "up" : "down"}`, title },
    h("span", { "aria-hidden": "true" }, up ? "↑ " : "↓ "),
    `${percent(Math.abs(now - before) / before)} ${up ? "more" : "fewer"} than the 30 days before`,
  );
}

/** Tiles of { label, value, sub?, trend?: [last 30 days, the 30 before] }. */
function tiles(container, items) {
  container.replaceChildren(
    ...items.map((item) =>
      h(
        "div",
        { class: "tile" },
        h("span", { class: "tile-label" }, item.label),
        h("span", { class: "tile-value" }, item.value),
        item.sub ? h("span", { class: "tile-sub" }, item.sub) : null,
        item.trend ? trend(item.trend) : null,
      ),
    ),
  );
}

/* ---------- Column chart ---------- */

// Each chart card redraws to its own width.
const resizer = new ResizeObserver((entries) => {
  for (const entry of entries) entry.target._draw?.();
});

/** A round step that splits 0..max into about three gridlines. Counts never step below 1. */
function niceStep(max) {
  const raw = max / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const n = raw / power;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power);
}

/** A column for the top of a stack: 4px rounded data end, square at the baseline. */
function columnPath(x, y, width, height, round) {
  const r = round ? Math.min(4, width / 2, height) : 0;
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/**
 * Stacked columns over time, with a legend (two or more series), a hover/keyboard tooltip and a
 * table view. `labels` are the x positions' names (days, weeks or months); `tips` their long form.
 */
function columnChart(card, { title, sub, labels, tips = labels, series, format = num, axis = (v) => compact.format(v), empty }) {
  card.replaceChildren();
  const totals = series.map((one) => sum(one.values));
  const caption = h(
    "figcaption",
    { class: "chart-head" },
    h("div", {}, h("div", { class: "chart-title" }, title), sub ? h("div", { class: "chart-sub" }, sub) : null),
    series.length > 1
      ? h(
          "ul",
          { class: "legend", "aria-label": "Legend" },
          series.map((one, i) =>
            h("li", {}, h("span", { class: "swatch", style: `background:${one.color}` }), one.name, " ", h("b", {}, format(totals[i]))),
          ),
        )
      : null,
  );
  card.append(caption);

  const stacks = labels.map((_, i) => sum(series.map((one) => one.values[i])));
  const max = Math.max(0, ...stacks);
  if (max === 0) {
    card.append(h("p", { class: "chart-empty" }, empty || "Nothing in this period yet."));
    card._draw = null;
    return;
  }

  const host = h("div", { class: "chart-plot" });
  const tooltip = h("div", { class: "chart-tooltip", hidden: true, "aria-live": "polite" });
  card.append(host, tooltip, chartTable({ labels: tips, series, format }));

  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  let active = -1;

  card._draw = () => {
    const W = Math.max(260, Math.floor(host.clientWidth));
    const H = 180;
    const m = { top: 8, right: 2, bottom: 22, left: Math.max(28, 8 + 7 * axis(top).length) };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;
    const n = labels.length;
    const slot = pw / n;
    const bar = Math.max(1, Math.min(24, slot - 2));
    const y = (v) => m.top + ph - (v / top) * ph;

    const root = s("svg", { class: "chart-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H, tabindex: 0, role: "img" });
    root.setAttribute("aria-label", `${title}. ${series.map((one, i) => `${one.name}: ${format(totals[i])}`).join(", ")}. Arrow keys step through the ${n} columns.`);
    for (const t of ticks) {
      root.append(s("line", { class: "grid", x1: m.left, x2: W - m.right, y1: Math.round(y(t)) + 0.5, y2: Math.round(y(t)) + 0.5 }));
      const label = s("text", { class: "tick", x: m.left - 6, y: y(t) + 4, "text-anchor": "end" });
      label.textContent = axis(t);
      root.append(label);
    }
    // About one x label per 80px, never cut off at the edges.
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 80))));
    for (let i = n - 1; i >= 0; i -= every) {
      const cx = m.left + slot * (i + 0.5);
      const label = s("text", { class: "tick", x: cx, y: H - 6, "text-anchor": i === n - 1 ? "end" : "middle" });
      if (i === n - 1) label.setAttribute("x", W - m.right);
      label.textContent = labels[i];
      if (cx > m.left + 24 || i === n - 1) root.append(label);
    }

    const band = s("rect", { class: "hover-band", x: 0, y: m.top, width: slot, height: ph, rx: 3 });
    root.append(band);
    for (let i = 0; i < n; i++) {
      const x = m.left + slot * i + (slot - bar) / 2;
      let base = 0;
      const lastSeries = series.findLastIndex((one) => one.values[i] > 0);
      series.forEach((one, k) => {
        const value = one.values[i] || 0;
        if (value <= 0) return;
        const yTop = y(base + value);
        // A 2px surface gap between stacked segments.
        const gap = base > 0 ? 2 : 0;
        const height = Math.max(1, y(base) - yTop - gap);
        root.append(s("path", { d: columnPath(x, yTop, bar, height, k === lastSeries), fill: one.color }));
        base += value;
      });
    }

    const show = (i) => {
      active = Math.max(0, Math.min(n - 1, i));
      band.setAttribute("x", m.left + slot * active);
      band.classList.add("is-on");
      tooltip.replaceChildren();
      append(tooltip, [
        h("div", { class: "tip-date" }, tips[active]),
        series.map((one) =>
          h("div", { class: "tip-row" }, h("span", { class: "tip-key", style: `background:${one.color}` }), h("b", {}, format(one.values[active] || 0)), one.name),
        ),
      ]);
      tooltip.hidden = false;
      const scale = root.getBoundingClientRect().width / W;
      const left = host.offsetLeft + (m.left + slot * (active + 0.5)) * scale;
      const width = tooltip.offsetWidth;
      tooltip.style.left = `${Math.max(4, Math.min(card.clientWidth - width - 4, left - width / 2))}px`;
      tooltip.style.top = `${Math.max(4, host.offsetTop - tooltip.offsetHeight + 8)}px`;
    };
    const hide = () => {
      band.classList.remove("is-on");
      tooltip.hidden = true;
    };
    root.addEventListener("pointermove", (event) => {
      const rect = root.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * W;
      if (x < m.left) return hide();
      show(Math.floor((x - m.left) / slot));
    });
    root.addEventListener("pointerleave", hide);
    root.addEventListener("blur", hide);
    root.addEventListener("focus", () => show(active >= 0 ? active : n - 1));
    root.addEventListener("keydown", (event) => {
      const moves = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: n - 1 };
      if (event.key in moves) {
        event.preventDefault();
        show(moves[event.key]);
      } else if (event.key === "Escape") hide();
    });
    host.replaceChildren(root);
  };
  card._draw();
  resizer.observe(card);
}

/** The chart's numbers as a table: every period with anything in it, newest first. */
function chartTable({ labels, series, format }) {
  const rows = [];
  for (let i = labels.length - 1; i >= 0; i--) {
    const values = series.map((one) => one.values[i] || 0);
    if (values.some((v) => v)) rows.push(h("tr", {}, h("td", {}, labels[i]), values.map((v) => h("td", { class: "num" }, format(v)))));
  }
  return h(
    "details",
    { class: "chart-table" },
    h("summary", {}, "Show as a table"),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "data-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Period"), series.map((one) => h("th", { scope: "col", class: "num" }, one.name)))),
        h("tbody", {}, rows),
      ),
    ),
    h("p", { class: "muted" }, "Periods that aren't listed had none."),
  );
}

/* ---------- Tabs ---------- */

const tabButtons = [...document.querySelectorAll('[role="tab"]')];
const tabName = (button) => button.id.replace("tab-", "");
const loaded = new Set();
const loaders = {};
let current = "overview";

async function run(name) {
  const panel = $(`panel-${name}`);
  panel.classList.add("is-loading");
  try {
    await loaders[name]();
    loaded.add(name);
    $("load-error").hidden = true;
  } catch (error) {
    const message =
      error instanceof ApiError && error.code === "not_admin"
        ? "Your Cloudflare Access sign-in isn't on the admin list (ADMIN_EMAILS), or it has expired. Reload the page to sign in again."
        : error.message || "That didn't load.";
    $("load-error").textContent = message;
    $("load-error").hidden = false;
  } finally {
    panel.classList.remove("is-loading");
  }
}

function select(name, { focus = false } = {}) {
  if (!loaders[name]) name = "overview";
  current = name;
  for (const button of tabButtons) {
    const on = tabName(button) === name;
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
    $(button.getAttribute("aria-controls")).hidden = !on;
    if (on && focus) button.focus();
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
  if (!loaded.has(name)) run(name);
}

for (const button of tabButtons) button.addEventListener("click", () => select(tabName(button)));
document.querySelector('[role="tablist"]').addEventListener("keydown", (event) => {
  const index = tabButtons.findIndex((b) => b.getAttribute("aria-selected") === "true");
  const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabButtons.length - 1 };
  if (!(event.key in moves)) return;
  event.preventDefault();
  select(tabName(tabButtons[(moves[event.key] + tabButtons.length) % tabButtons.length]), { focus: true });
});
$("refresh").addEventListener("click", () => run(current));

/* ---------- Overview ---------- */

function header(data) {
  $("who").textContent = `Signed in as ${data.admin}`;
  const env = $("environment");
  env.hidden = false;
  env.className = `badge ${data.environment === "production" ? "badge-success" : "badge-warn"}`;
  env.textContent = data.environment === "production" ? "Live payments" : "Sandbox payments";
}

function attention(text, kind, label, onclick) {
  return h(
    "div",
    { class: `notice notice-${kind}` },
    h("span", {}, text),
    label ? h("button", { class: "link-button", type: "button", onclick, style: "margin-left:auto" }, label) : null,
  );
}

loaders.overview = async () => {
  const o = await api("/admin/overview");
  header(o);
  const p = o.previous30;
  tiles($("overview-tiles"), [
    {
      label: "Downloads, 30 days",
      value: num(o.downloads.last30),
      sub: `Windows ${num(o.downloads.windows)} · macOS ${num(o.downloads.macos)}${notPeople(o.downloads.bots, o.downloads.team)}`,
      trend: [o.downloads.last30, p.downloads],
    },
    {
      label: "Page views, 30 days",
      value: num(o.pageViews.last30),
      sub: `${num(o.pageViews.home)} of the home page`,
      trend: [o.pageViews.last30, p.pageViews],
    },
    {
      label: "Update checks, 30 days",
      value: num(o.launches.last30),
      sub: "Copies from 1.0.2 on, outside the Store. Not users or installs",
      trend: [o.launches.last30, p.launches],
    },
    {
      label: "Accounts",
      value: num(o.accounts.total),
      sub: `${num(o.accounts.last30)} new · ${num(o.accounts.activeDesktop)} used the app, last 30 days`,
      trend: [o.accounts.last30, p.accounts],
    },
    {
      label: "Sync subscribers",
      value: num(o.sync.subscribers),
      sub: `${plural(o.sync.budgets, "budget")} · ${formatBytes(o.sync.bytes)} stored`,
    },
    {
      label: "Sync checkouts, 30 days",
      value: num(o.funnel.checkouts),
      sub: "Opened at Polar, paid or not",
      trend: [o.funnel.checkouts, p.checkouts],
    },
  ]);

  const notes = [];
  if (o.environment !== "production") notes.push(attention("Payments are in Polar's sandbox: checkout takes test cards only.", "warn"));
  const problems = sum(Object.values(o.health.problems30));
  if (problems)
    notes.push(attention(`${plural(problems, "problem")} in the last 30 days, such as emails that didn't send.`, "warn", "Open Health", () => select("health")));
  const mail = o.health.emails;
  if (nearLimit(mail.today, mail.perDay) || nearLimit(mail.month, mail.perMonth))
    notes.push(
      attention(
        `${num(mail.today)} emails sent today and ${num(mail.month)} this month: Resend's free plan stops at ${num(mail.perDay)} a day and ${num(mail.perMonth)} a month, and sign-in codes stop with it.`,
        "warn",
        "Open Health",
        () => select("health"),
      ),
    );
  const cleanup = cleanupLate(o.health.lastCleanup, o.countingSince);
  if (cleanup) notes.push(attention(cleanup, "warn", "Open Health", () => select("health")));
  $("overview-attention").replaceChildren(...notes);

  funnel(o.funnel, o.countingSince);
  weeks(o.weeks, o.countingSince);

  const days = o.daily.days;
  const labels = days.map(shortDay);
  const tips = days.map(dateOnly);
  columnChart($("chart-downloads"), {
    title: "Downloads per day",
    sub: "Last 90 days · clicks on urbudget.app's download buttons",
    labels,
    tips,
    series: [
      { name: "Windows", values: o.daily.windows, color: "var(--series-1)" },
      { name: "macOS", values: o.daily.macos, color: "var(--series-2)" },
    ],
    empty: "No downloads counted yet. Counting started with the admin page.",
  });
  columnChart($("chart-checkouts"), {
    title: "Sync checkouts per day",
    sub: "Last 90 days · opened at Polar, paid or not",
    labels,
    tips,
    series: [{ name: "Checkouts", values: o.daily.checkouts, color: "var(--series-1)" }],
    empty: "No Sync checkouts opened yet.",
  });
  columnChart($("chart-signups"), {
    title: "New accounts per day",
    sub: "Last 90 days",
    labels,
    tips,
    series: [{ name: "New accounts", values: o.daily.signups, color: "var(--series-1)" }],
  });
};

/** The steps from a visit to a Sync checkout, each with its share of the step before. */
function funnel(f, countingSince) {
  const steps = [
    ["Page views", f.views],
    ["Downloads", f.downloads],
    ["Sync checkouts opened", f.checkouts],
  ];
  $("funnel").replaceChildren(
    ...steps.map(([label, n], i) => {
      const before = i ? steps[i - 1][1] : 0;
      // Not a share when the step before had fewer: those came in through another door, or earlier.
      const share = before && n <= before ? `${percent(n / before)} of the step before` : "";
      return h("li", {}, h("span", { class: "funnel-value" }, num(n)), h("span", { class: "funnel-label" }, label), share ? h("span", { class: "funnel-share" }, share) : null);
    }),
  );
  const since =
    !countingSince || countingSince > daysAgo(29)
      ? ` Checkouts are counted from ${countingSince ? dateOnly(countingSince) : "this version of the Worker"} on.`
      : "";
  $("funnel-note").textContent = `People only, last 30 days. A step can outnumber the one before it: a download from a link to the installer, or a checkout from someone who downloaded earlier.${since}`;
}

/** YYYY-MM-DD for `n` days before today (UTC), as the API counts days. */
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Whether emails sent are within 20% of one of Resend's limits. */
const nearLimit = (sent, limit) => sent >= limit * 0.8;

/** Why the daily clean-up looks stuck, or "" when it ran in the last two days (or nothing was counted yet). */
function cleanupLate(last, countingSince) {
  if (last) return last < daysAgo(2) ? `The daily clean-up last ran on ${dateOnly(last)}. Check the Worker's cron trigger.` : "";
  return countingSince && countingSince < daysAgo(2) ? `The daily clean-up hasn't run since counting began on ${dateOnly(countingSince)}. Check the Worker's cron trigger.` : "";
}

/** "hn 12, tool-loan 5, …": the most-used link tags. */
const tagList = (tags, top) => `${tags.slice(0, top).map((t) => `${t.tag} ${num(t.n)}`).join(", ")}${tags.length > top ? ", …" : ""}`;
/** "34 (hn 12, tool-loan 5)": a week's downloads with its top link tags. */
const withTags = (downloads, tags) => `${num(downloads)}${tags.length ? ` (${tagList(tags, 3)})` : ""}`;

/** The week's row for marketing/weekly-log.md: this page's columns filled, the rest blank. */
function weeklyLogRow(week) {
  const cells = [dateOnly(week.start), "", "", "", "", withTags(week.downloads, week.tags), "", "", ""];
  return `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`.replace(/ {2,}/g, " ");
}

/** YYYY-MM-DD `n` days after a YYYY-MM-DD day. */
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The weeks, newest first. The first is this week so far, which isn't ready for the weekly log yet. */
function weeks(rows, countingSince) {
  const notCounted = () => h("span", { class: "muted", title: "Checkouts weren't counted yet" }, "—");
  fillTable(
    $("weeks-table"),
    rows.map((week, i) =>
      h(
        "tr",
        {},
        h("td", { class: "mono" }, shortDay(week.start), i === 0 ? h("span", { class: "muted" }, " so far") : null),
        h("td", { class: "num" }, num(week.views)),
        h("td", { class: "num" }, num(week.downloads)),
        h("td", { class: "detail" }, week.tags.length ? tagList(week.tags, 5) : h("span", { class: "muted" }, "None")),
        h("td", { class: "num" }, countingSince && addDays(week.start, 6) >= countingSince ? num(week.checkouts) : notCounted()),
        h("td", { class: "num" }, num(week.accounts)),
        h("td", { class: "num" }, num(week.launches)),
        h(
          "td",
          {},
          i === 0
            ? null
            : h(
                "button",
                {
                  class: "btn btn-sm btn-ghost",
                  type: "button",
                  title: `Copy the week of ${dateOnly(week.start)} as a row for marketing/weekly-log.md`,
                  onclick: (event) => copyText(weeklyLogRow(week), event.currentTarget),
                },
                h("span", { "data-label": true }, "Copy"),
              ),
        ),
      ),
    ),
    "No weeks yet.",
  );
}

/* ---------- Accounts ---------- */

const accountState = { q: "", filter: "all", page: 0 };
const SUBSCRIPTION = { active: "Active", trialing: "Trial", past_due: "Payment due", canceled: "Canceled", unpaid: "Unpaid", incomplete: "Incomplete", paused: "Paused" };
const LIVE = new Set(["active", "trialing", "past_due"]);

function subscriptionBadge(status) {
  return badge(`Sync: ${SUBSCRIPTION[status] || status}`, status === "active" || status === "trialing" ? "success" : LIVE.has(status) ? "warn" : "");
}

loaders.accounts = async () => {
  const { q, filter, page } = accountState;
  const data = await api(`/admin/accounts?${new URLSearchParams({ q, filter, page: String(page) })}`);
  fillTable(
    $("account-table"),
    data.accounts.map((account) =>
      h(
        "tr",
        { onclick: (event) => !event.target.closest("button") && openAccount(account.id) },
        h("td", {}, h("button", { class: "row-button row-button-text", type: "button", onclick: () => openAccount(account.id) }, account.email)),
        h(
          "td",
          {},
          h(
            "span",
            { class: "badges" },
            account.subscription ? subscriptionBadge(account.subscription) : h("span", { class: "muted" }, "Nothing"),
          ),
        ),
        h("td", { class: "num" }, num(account.devices)),
        h("td", { class: "num" }, num(account.budgets)),
        h("td", {}, account.lastSeenAt ? dateOnly(account.lastSeenAt) : h("span", { class: "muted" }, "Signed out")),
        h("td", {}, dateOnly(account.createdAt)),
      ),
    ),
    q || filter !== "all" ? "No accounts match." : "No accounts yet.",
  );
  const from = data.total ? page * data.pageSize + 1 : 0;
  const to = Math.min(data.total, (page + 1) * data.pageSize);
  $("account-count").textContent = data.total ? `${num(from)}–${num(to)} of ${plural(data.total, "account")}` : "";
  $("account-prev").disabled = page === 0;
  $("account-next").disabled = to >= data.total;
};

$("account-search").addEventListener("submit", (event) => {
  event.preventDefault();
  accountState.q = $("account-q").value.trim();
  accountState.filter = $("account-filter").value;
  accountState.page = 0;
  run("accounts");
});
$("account-filter").addEventListener("change", () => $("account-search").requestSubmit());
$("account-prev").addEventListener("click", () => {
  accountState.page = Math.max(0, accountState.page - 1);
  run("accounts");
});
$("account-next").addEventListener("click", () => {
  accountState.page += 1;
  run("accounts");
});

const accountDialog = $("account-dialog");
accountDialog.addEventListener("click", (event) => {
  if (event.target.closest("[data-close]")) return accountDialog.close();
  if (event.target !== accountDialog) return;
  const box = accountDialog.getBoundingClientRect();
  const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  if (!inside) accountDialog.close();
});

/** Shows an error where the admin is looking: in the account dialog if it's open, or above the tabs. */
function showError(message) {
  if (accountDialog.open) return setStatus($("account-status"), message, "error");
  $("load-error").textContent = message;
  $("load-error").hidden = false;
}

async function openAccount(id) {
  try {
    const data = await api(`/admin/accounts/${encodeURIComponent(id)}`);
    setStatus($("account-status"), "");
    renderAccount(data);
    if (!accountDialog.open) accountDialog.showModal();
  } catch (error) {
    showError(error.message);
  }
}

function renderAccount({ account, subscriptions, sessions, budgets, syncKeySetAt }) {
  $("account-title").textContent = account.email;
  const fact = (term, ...value) => [h("dt", {}, term), h("dd", {}, ...value)];
  const seen = sessions.map((s) => s.lastSeenAt).sort().at(-1);
  $("account-facts").replaceChildren(
    ...fact("Created", when(account.createdAt)),
    ...fact("Last seen", seen ? when(seen) : h("span", { class: "muted" }, "Signed out everywhere")),
    ...fact("Polar customer", account.customerId ? h("span", { class: "mono" }, account.customerId) : h("span", { class: "muted" }, "None yet")),
    ...fact("Sync passphrase", syncKeySetAt ? `Set ${when(syncKeySetAt)}` : h("span", { class: "muted" }, "Not set")),
    ...fact("Account id", h("span", { class: "mono" }, account.id)),
  );
  $("account-subscriptions").replaceChildren(
    ...(subscriptions.length
      ? subscriptions.map((sub) =>
          h(
            "li",
            {},
            subscriptionBadge(sub.status),
            " ",
            sub.cancelAt
              ? `Ends ${dateOnly(sub.cancelAt)}`
              : sub.live && sub.currentPeriodEnd
                ? `Renews ${dateOnly(sub.currentPeriodEnd)}`
                : sub.currentPeriodEnd
                  ? `Ended ${dateOnly(sub.currentPeriodEnd)}`
                  : "",
            h("div", { class: "muted" }, `Updated ${when(sub.updatedAt)} · `, h("span", { class: "mono" }, sub.id)),
          ),
        )
      : [h("li", { class: "muted" }, "Never subscribed.")]),
  );
  fillTable(
    $("account-sessions"),
    sessions.map((s) =>
      h(
        "tr",
        {},
        h("td", {}, s.kind === "desktop" ? ["The app", s.deviceName ? h("span", { class: "muted" }, ` · ${s.deviceName}`) : null] : "The website"),
        h("td", {}, when(s.lastSeenAt)),
        h("td", {}, dateOnly(s.createdAt)),
      ),
    ),
    "Not signed in anywhere.",
  );
  fillTable(
    $("account-budgets"),
    budgets.map((b) =>
      h(
        "tr",
        {},
        h("td", { class: "mono" }, b.id),
        h("td", { class: "num" }, formatBytes(b.size)),
        h("td", { class: "num" }, num(b.revision)),
        h("td", {}, b.device || h("span", { class: "muted" }, "Not known")),
        h("td", {}, when(b.updatedAt)),
      ),
    ),
    "Nothing synced.",
  );
}

/* ---------- Traffic ---------- */

loaders.traffic = async () => {
  const t = await api("/admin/traffic");
  const last30 = (values) => sum(values.slice(-30));
  const launches30 = last30(t.launches.windows) + last30(t.launches.macos);
  tiles($("traffic-tiles"), [
    { label: "Page views, 30 days", value: num(t.last30.people), sub: `${num(sum(t.views))} in 90 days` },
    {
      label: "Download rate, 30 days",
      value: t.last30.people ? percent(t.last30.downloads / t.last30.people) : "—",
      sub: `${num(t.last30.downloads)} downloads for ${num(t.last30.people)} page views`,
    },
    {
      label: "Bots and team, 30 days",
      value: num(t.last30.bots + t.last30.team),
      sub: `${num(t.last30.bots)} bots and agents · ${num(t.last30.team)} from this page's browsers`,
    },
    { label: "Update checks, 30 days", value: num(launches30), sub: `Windows ${num(last30(t.launches.windows))} · macOS ${num(last30(t.launches.macos))}` },
  ]);
  columnChart($("chart-views-90"), {
    title: "Page views per day",
    sub: "Last 90 days · people only; bots, AI agents and the team are counted apart",
    labels: t.days.map(shortDay),
    tips: t.days.map(dateOnly),
    series: [{ name: "Page views", values: t.views, color: "var(--series-1)" }],
    empty: "No page views counted yet.",
  });
  fillTable(
    $("pages-table"),
    t.pages.map((row) => h("tr", {}, h("td", { class: "mono" }, row.path), h("td", { class: "num" }, num(row.n)))),
    "No page views yet.",
  );
  fillTable(
    $("visit-sources-table"),
    t.sources.map((row) => h("tr", {}, h("td", {}, row.source ? row.source : h("span", { class: "muted" }, "Not known")), h("td", { class: "num" }, num(row.n)))),
    "No page views yet.",
  );
  fillTable(
    $("tags-table"),
    t.tags.map((row) =>
      h(
        "tr",
        {},
        h("td", { class: "mono" }, row.tag),
        h("td", { class: "num" }, num(row.views)),
        h("td", { class: "num" }, num(row.downloads)),
        h("td", { class: "num" }, row.views ? percent(row.downloads / row.views) : "—"),
        h("td", {}, dateOnly(row.first)),
        h("td", {}, dateOnly(row.last)),
      ),
    ),
    "No tagged links counted yet. Add ?ref=name to a link you post.",
  );
  columnChart($("chart-launches-90"), {
    title: "Update checks per day",
    sub: "Last 90 days · copies of 1.0.2 and later, outside the Store · about one a launch, not users or installs",
    labels: t.days.map(shortDay),
    tips: t.days.map(dateOnly),
    series: [
      { name: "Windows", values: t.launches.windows, color: "var(--series-1)" },
      { name: "macOS", values: t.launches.macos, color: "var(--series-2)" },
    ],
    empty: "No update checks yet. Copies from 1.0.2 on are counted.",
  });
  fillTable(
    $("launch-versions-table"),
    t.versions.map((row) =>
      h(
        "tr",
        {},
        h("td", {}, row.version),
        h("td", {}, row.platform === "darwin" ? "macOS" : row.platform === "windows" ? "Windows" : row.platform),
        h("td", { class: "num" }, num(row.n)),
        h("td", {}, dateOnly(row.last)),
      ),
    ),
    "No update checks yet.",
  );
};

/* ---------- Downloads ---------- */

/** " · plus 6 from bots and the team", or nothing. Only people count as downloads. */
function notPeople(bots, team) {
  const n = (bots ?? 0) + (team ?? 0);
  return n ? ` · plus ${num(n)} from bots and the team` : "";
}

loaders.downloads = async () => {
  const d = await api("/admin/downloads");
  const last30 = (values) => sum(values.slice(-30));
  tiles($("downloads-tiles"), [
    { label: "Downloads, 30 days", value: num(last30(d.windows) + last30(d.macos)), sub: `${num(sum(d.windows) + sum(d.macos))} in 90 days` },
    { label: "Windows, 30 days", value: num(last30(d.windows)) },
    { label: "macOS, 30 days", value: num(last30(d.macos)) },
    {
      label: "Bots and team, 30 days",
      value: num(d.others.bots.last30 + d.others.team.last30),
      sub: `${num(d.others.bots.last30)} bots and agents · ${num(d.others.team.last30)} from this page's browsers`,
    },
    d.latest
      ? { label: "Latest release", value: d.latest.version, sub: `Published ${dateOnly(d.latest.date)}` }
      : { label: "Latest release", value: "None", sub: "Nothing published yet" },
  ]);
  columnChart($("chart-downloads-90"), {
    title: "Downloads per day",
    sub: "Last 90 days · people's clicks on a download button; bots, AI agents and the team are counted apart",
    labels: d.days.map(shortDay),
    tips: d.days.map(dateOnly),
    series: [
      { name: "Windows", values: d.windows, color: "var(--series-1)" },
      { name: "macOS", values: d.macos, color: "var(--series-2)" },
    ],
    empty: "No downloads counted yet. Counting started with the admin page.",
  });
  fillTable(
    $("sources-table"),
    d.sources.map((row) =>
      h(
        "tr",
        {},
        h("td", {}, row.source ? (row.source.startsWith("/") ? h("span", { class: "mono" }, row.source) : row.source) : h("span", { class: "muted" }, "Not known")),
        h("td", { class: "num" }, num(row.n)),
      ),
    ),
    "No downloads yet.",
  );
  fillTable(
    $("versions-table"),
    d.versions.map((row) =>
      h(
        "tr",
        {},
        h("td", {}, row.version),
        h("td", {}, row.platform === "macos" ? "macOS" : "Windows"),
        h("td", { class: "num" }, num(row.n)),
        h("td", {}, dateOnly(row.last)),
      ),
    ),
    "No downloads yet.",
  );

  const github = $("github");
  if (!d.github.configured) github.replaceChildren(h("p", { class: "muted small" }, "Set GITHUB_REPO and the GITHUB_TOKEN secret to see these."));
  else if (d.github.error) github.replaceChildren(h("p", { class: "notice notice-warn" }, d.github.error));
  else if (!d.github.releases.length) github.replaceChildren(h("p", { class: "muted small" }, "No published releases."));
  else
    github.replaceChildren(
      ...d.github.releases.map((release) =>
        h(
          "div",
          { class: "github-release" },
          h("h3", {}, release.name, " ", h("span", { class: "muted" }, release.publishedAt ? `· ${dateOnly(release.publishedAt)}` : ""), release.prerelease ? [" ", badge("Pre-release", "warn")] : null),
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "data-table" },
              h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "File"), h("th", { scope: "col", class: "num" }, "Size"), h("th", { scope: "col", class: "num" }, "Downloads"))),
              h(
                "tbody",
                {},
                release.assets.length
                  ? release.assets.map((asset) =>
                      h("tr", {}, h("td", { class: "mono" }, asset.name), h("td", { class: "num" }, formatBytes(asset.size)), h("td", { class: "num" }, num(asset.downloads))),
                    )
                  : h("tr", { class: "empty" }, h("td", { colspan: 3 }, "No files.")),
              ),
            ),
          ),
        ),
      ),
    );
};

/* ---------- Revenue ---------- */

let revenueDays = "30";
// The order tiles appear in; stock numbers (MRR, active subscriptions) show their latest value.
const TILES = [
  ["revenue", "total"],
  ["net_revenue", "total"],
  ["orders", "total"],
  ["one_time_products", "total"],
  ["monthly_recurring_revenue", "latest"],
  ["active_subscriptions", "latest"],
  ["new_subscriptions", "total"],
  ["churned_subscriptions", "total"],
  ["checkouts_conversion", "total"],
];
const PERIOD = { day: "day", week: "week", month: "month" };

function metricFormat(type) {
  if (type === "currency") return money;
  if (type === "percentage") return (v) => percent(v);
  return num;
}
function periodLabel(start, interval, long = false) {
  const date = new Date(start);
  if (interval === "month") return date.toLocaleDateString("en-US", { month: long ? "long" : "short", year: "numeric", timeZone: "UTC" });
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(long ? { year: "numeric" } : {}), timeZone: "UTC" });
  return interval === "week" && long ? `Week of ${day}` : day;
}

for (const button of document.querySelectorAll(".segmented [data-days]")) {
  button.addEventListener("click", () => {
    revenueDays = button.dataset.days;
    for (const other of document.querySelectorAll(".segmented [data-days]")) other.setAttribute("aria-checked", String(other === button));
    run("revenue");
  });
}

loaders.revenue = async () => {
  const error = $("revenue-error");
  let r;
  try {
    r = await api(`/admin/revenue?days=${revenueDays}`);
  } catch (failure) {
    if (!(failure instanceof ApiError) || failure.code === "not_admin" || failure.status === 0) throw failure;
    error.textContent = failure.message;
    error.hidden = false;
    $("revenue-tiles").replaceChildren();
    $("chart-revenue").hidden = true;
    $("revenue-table").tHead.replaceChildren();
    fillTable($("revenue-table"), [], "No numbers.");
    return;
  }
  error.hidden = true;
  $("revenue-source").textContent = `From Polar (${r.environment === "production" ? "live" : "sandbox"}), by ${PERIOD[r.interval]}, since ${dateOnly(r.start)}`;
  const known = new Map(r.metrics.map((m) => [m.slug, m]));
  const latest = r.periods.at(-1) ?? {};
  const items = [];
  for (const [slug, how] of TILES) {
    const metric = known.get(slug);
    if (!metric) continue;
    const value = how === "latest" ? latest[slug] : r.totals[slug];
    items.push({ label: metric.name, value: value === null || value === undefined ? "—" : metricFormat(metric.type)(value), sub: how === "latest" ? "Now" : null });
  }
  tiles($("revenue-tiles"), items);

  const revenue = known.get("revenue");
  $("chart-revenue").hidden = !revenue;
  if (revenue)
    columnChart($("chart-revenue"), {
      title: `Revenue per ${PERIOD[r.interval]}`,
      sub: "Before Polar's fees and refunds",
      labels: r.periods.map((p) => periodLabel(p.start, r.interval)),
      tips: r.periods.map((p) => periodLabel(p.start, r.interval, true)),
      series: [{ name: "Revenue", values: r.periods.map((p) => p.revenue || 0), color: "var(--series-1)" }],
      format: money,
      axis: (cents) => `$${compact.format(cents / 100)}`,
      empty: "No revenue in this range yet.",
    });

  const columns = r.metrics;
  $("revenue-table").tHead.replaceChildren(
    h("tr", {}, h("th", { scope: "col" }, "Period"), columns.map((m) => h("th", { scope: "col", class: "num" }, m.name))),
  );
  fillTable(
    $("revenue-table"),
    [...r.periods].reverse().map((period) =>
      h(
        "tr",
        {},
        h("td", {}, periodLabel(period.start, r.interval, true)),
        columns.map((m) => h("td", { class: "num" }, period[m.slug] === null ? "—" : metricFormat(m.type)(period[m.slug]))),
      ),
    ),
    "No periods.",
  );
};

/* ---------- Health ---------- */

const PROBLEM = { email: "Email not sent", webhook: "Webhook failed", rate_limit: "Rate limit hit" };
// What each counted event is, in the order the Activity table lists them.
const ACTIVITY = {
  "sign_in:web": "Sign-ins on the website",
  "sign_in:desktop": "Sign-ins in the app",
  "sign_in:link": "The app opening the website signed in",
  "email:sign-in code": "Sign-in codes emailed",
  "checkout:sync": "Sync checkouts opened",
  "sync_upload:ok": "Budgets uploaded to sync",
  "sync_upload:conflict": "Sync uploads refused: another computer synced first",
  "account_deleted:": "Accounts deleted by their owners",
};
const activityOrder = Object.keys(ACTIVITY);
const activityRank = (key) => (activityOrder.includes(key) ? activityOrder.indexOf(key) : activityOrder.length);

let reportOffset = 0;
let reportsBusy = false;

async function loadAssistantReports(offset = reportOffset) {
  if (reportsBusy) return;
  reportsBusy = true;
  $("assistant-reports-newer").disabled = true;
  $("assistant-reports-older").disabled = true;
  setStatus($("assistant-reports-status"), "");
  try {
    const data = await api(`/admin/assistant-reports?offset=${offset}`);
    reportOffset = offset;
    $("assistant-reports").replaceChildren(...data.reports.map((report) => {
      const remove = h("button", { class: "btn btn-sm", type: "button", onclick: async () => {
        if (!window.confirm(`Delete report ${report.id}? This cannot be undone.`)) return;
        remove.disabled = true;
        try {
          await api(`/admin/assistant-reports/${encodeURIComponent(report.id)}`, { method: "DELETE" });
          loaded.delete("log");
          await loadAssistantReports();
        } catch (error) {
          setStatus($("assistant-reports-status"), error.message, "error");
          remove.disabled = false;
        }
      } }, "Delete report");
      // Treat submitted text as text, including markup, links and instructions.
      return h("details", { class: "assistant-report" },
        h("summary", {}, `${when(report.createdAt)} · ${report.id}`),
        h("p", {}, h("strong", {}, "Reason: "), report.reason || "No reason supplied."),
        h("pre", {}, report.reply), remove);
    }));
    if (!data.reports.length) $("assistant-reports").append(h("p", { class: "muted" }, "No reports on this page."));
    $("assistant-reports-newer").disabled = reportOffset === 0;
    $("assistant-reports-older").disabled = !data.hasMore;
  } catch (error) {
    setStatus($("assistant-reports-status"), error.message, "error");
    $("assistant-reports-newer").disabled = reportOffset === 0;
  } finally {
    reportsBusy = false;
  }
}

$("assistant-reports-newer").addEventListener("click", () => loadAssistantReports(Math.max(0, reportOffset - 50)));
$("assistant-reports-older").addEventListener("click", () => loadAssistantReports(reportOffset + 50));

loaders.health = async () => {
  await loadAssistantReports();
  const data = await api("/admin/health");
  const mail = data.emails;
  const usage = (sent, limit) => badge(`${num(sent)} of ${num(limit)}`, nearLimit(sent, limit) ? "warn" : "success");
  const late = cleanupLate(data.lastCleanup, data.countingSince);
  $("activity-limits").replaceChildren(
    h("li", {}, usage(mail.today, mail.perDay), "Emails sent today"),
    h("li", {}, usage(mail.month, mail.perMonth), "Emails sent this month"),
    h(
      "li",
      {},
      data.lastCleanup ? badge(dateOnly(data.lastCleanup), late ? "warn" : "success") : badge("Not yet", late ? "warn" : ""),
      "Daily clean-up last ran",
    ),
  );
  $("activity-note").textContent = data.countingSince
    ? `Daily totals counted since ${dateOnly(data.countingSince)}, nothing about who. Email limits are Resend's free plan.`
    : "Nothing counted yet: counting starts with this version of the Worker. Email limits are Resend's free plan.";
  fillTable(
    $("activity-table"),
    [...data.activity]
      .sort((a, b) => activityRank(`${a.name}:${a.detail}`) - activityRank(`${b.name}:${b.detail}`))
      .map((row) =>
        h(
          "tr",
          {},
          h("td", {}, ACTIVITY[`${row.name}:${row.detail}`] || `${row.name}${row.detail ? ` (${row.detail})` : ""}`),
          h("td", { class: "num" }, num(row.last7)),
          h("td", { class: "num" }, num(row.last30)),
        ),
      ),
    "Nothing in the last 30 days.",
  );
  $("settings").replaceChildren(
    ...data.settings.map((setting) =>
      h(
        "li",
        {},
        setting.value ? badge(setting.value, setting.ok ? "success" : "warn") : setting.ok ? badge("Set", "success") : badge("Not set", "warn"),
        h("code", {}, setting.name),
      ),
    ),
  );
  fillTable(
    $("problems-table"),
    data.problems.map((p) =>
      h("tr", {}, h("td", { class: "mono" }, when(p.at)), h("td", {}, PROBLEM[p.kind] || p.kind), h("td", {}, p.subject), h("td", { class: "detail" }, p.detail)),
    ),
    "No problems in the last 90 days.",
  );
  fillTable(
    $("webhook-types"),
    data.webhookTypes.map((w) => h("tr", {}, h("td", { class: "mono" }, w.type), h("td", { class: "num" }, num(w.n)), h("td", {}, when(w.last)))),
    "No webhooks in the last 30 days.",
  );
  fillTable(
    $("webhook-recent"),
    data.webhooks.map((w) => h("tr", {}, h("td", { class: "mono" }, w.type), h("td", {}, when(w.at)))),
    "No webhooks yet.",
  );
};

/* ---------- Log ---------- */

const ACTIONS = { delete_assistant_report: "Deleted assistant report" };

loaders.log = async () => {
  const { entries } = await api("/admin/log");
  fillTable(
    $("log-table"),
    entries.map((e) =>
      h(
        "tr",
        {},
        h("td", { class: "mono" }, when(e.at)),
        h("td", {}, e.admin),
        h("td", {}, ACTIONS[e.action] || e.action),
        h("td", { class: "detail" }, e.detail),
      ),
    ),
    "Nothing changed from this page yet.",
  );
};

/* ---------- Start ---------- */

const first = location.hash.slice(1);
select(loaders[first] ? first : "overview");
// The header (who's signed in, sandbox or live) comes with the overview.
if (current !== "overview") run("overview");
