// The reports widget on the home page: five of UrBudget's reports drawn from a sample household,
// with the date range, hover readouts and a data table for screen readers. Charts are plain SVG
// sized to their box, redrawn when it changes size. Without this script the section keeps the
// screenshot it starts with.

import { inView, showOnce } from "./ghost.js";

/* ---------- Sample household ---------- */

const MONTHS = ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"];
const YEARS = [2025, 2025, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026];
const INCOME = [7700, 9200, 7700, 7700, 7700, 8600, 7700, 7700, 7700, 7700, 7700, 7700];

// [category, monthly amount, how much it varies, payees as [name, share, purchases a month], one-off months]
const GROUPS = [
  { name: "Bills", color: "#7c5cff", cats: [
    ["Rent", 1950, 0, [["Maple Street Rentals", 1, 1]]],
    ["Electricity", 140, 0.2, [["City Power & Light", 1, 1]], { 7: 210, 8: 230, 9: 220 }],
    ["Water", 48, 0.1, [["Metro Water", 1, 1]]],
    ["Internet", 70, 0, [["FiberNet", 1, 1]]],
    ["Mobile phones", 85, 0, [["Horizon Wireless", 1, 1]]],
    ["Car insurance", 95, 0, [["Shield Auto Insurance", 1, 1]]],
    ["Health insurance", 210, 0, [["Evergreen Health", 1, 1]]],
  ] },
  { name: "Everyday", color: "#1f9d6b", cats: [
    ["Groceries", 980, 0.12, [["Trader Joe's", 0.4, 6], ["Costco", 0.35, 2], ["Safeway", 0.25, 4]]],
    ["Dining out", 320, 0.25, [["Chipotle", 0.35, 4], ["Thai Basil", 0.3, 2], ["DoorDash", 0.35, 3]]],
    ["Coffee", 60, 0.2, [["Blue Bottle", 0.6, 8], ["Corner Café", 0.4, 6]]],
    ["Fuel", 210, 0.15, [["Shell", 0.6, 3], ["Chevron", 0.4, 2]]],
    ["Transport", 80, 0.3, [["Lyft", 0.7, 4], ["Metro Transit", 0.3, 6]]],
  ] },
  { name: "Family", color: "#2f7fe0", cats: [
    ["Childcare", 900, 0, [["Bright Start Daycare", 1, 1]]],
    ["School", 300, 0, [["Oakwood Academy", 1, 1]]],
    ["Activities", 120, 0.3, [["City Rec Center", 1, 2]]],
  ] },
  { name: "Debt", color: "#ef8a2e", cats: [
    ["Car loan", 420, 0, [["Toyota Financial", 1, 1]]],
    ["Card interest", 30, 0.5, [["Visa", 1, 1]]],
  ] },
  { name: "Lifestyle", color: "#e5566a", cats: [
    ["Gym", 45, 0, [["Planet Fitness", 1, 1]]],
    ["Streaming", 35, 0, [["Netflix", 1, 1]]],
    ["Hobbies", 90, 0.4, [["Etsy", 1, 2]]],
    ["Clothing", 110, 0.5, [["Old Navy", 1, 2]]],
  ] },
  { name: "Annual", color: "#d9a400", cats: [
    ["Gifts", 40, 0.3, [["Amazon", 1, 2]], { 1: 640 }],
    ["Travel", 0, 0, [["Delta Air Lines", 1, 1]], { 8: 1420 }],
    ["Car registration", 0, 0, [["DMV", 1, 1]], { 4: 214 }],
  ] },
];

/** A small seeded random generator, so the sample is the same on every visit. */
function seeded(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cents = (n) => Math.round(n * 100) / 100;

function household() {
  const random = seeded(20261016);
  const spend = []; // spend[month] = { group: total }
  const payees = new Map(); // name → { total per month, purchases per month }
  for (let m = 0; m < 12; m++) {
    const byGroup = {};
    for (const group of GROUPS) {
      let total = 0;
      for (const [, base, vary, split, once = {}] of group.cats) {
        const amount = cents(once[m] ?? base * (1 + vary * (random() * 2 - 1)));
        total += amount;
        for (const [name, share, count] of split) {
          const p = payees.get(name) ?? { amount: Array(12).fill(0), count: Array(12).fill(0) };
          p.amount[m] += amount * share;
          p.count[m] += amount ? count : 0;
          payees.set(name, p);
        }
      }
      byGroup[group.name] = cents(total);
    }
    spend.push(byGroup);
  }
  // Net worth: savings and investments grow with what's left each month; the car loan shrinks.
  const worth = [];
  let assets = 52840;
  let loan = 7920;
  for (let m = 0; m < 12; m++) {
    const spent = Object.values(spend[m]).reduce((a, b) => a + b, 0);
    assets = cents(assets * 1.004 + (INCOME[m] - spent) + 360);
    loan = cents(loan - 330);
    const card = cents(520 + random() * 420);
    worth.push({ assets, debts: cents(loan + card) });
  }
  return { spend, payees, worth };
}
const DATA = household();

/* ---------- Formatting ---------- */

const money = (n, digits = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
const compact = (n) => {
  const a = Math.abs(n);
  const s = a >= 1000 ? `${+(a / 1000).toFixed(a >= 10000 ? 0 : 1)}K` : `${Math.round(a)}`;
  return `${n < 0 ? "−" : ""}$${s}`;
};
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sum = (list) => list.reduce((a, b) => a + b, 0);
const lastMonths = (n) => [...Array(n).keys()].map((i) => 12 - n + i);
const monthLabel = (m) => `${MONTHS[m]} ${YEARS[m]}`;

/* ---------- Chart helpers ---------- */

/** Nice round gridlines between 0 (or min) and max. */
function ticks(min, max, count = 4) {
  const span = max - min || 1;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const nice = [1, 2, 2.5, 5, 10].map((f) => f * step).find((s) => span / s <= count) ?? step * 10;
  const lo = Math.floor(min / nice) * nice;
  const hi = Math.ceil(max / nice) * nice;
  const out = [];
  for (let v = lo; v <= hi + nice / 2; v += nice) out.push(Math.round(v * 100) / 100);
  return out;
}

function grid(values, y, left, right) {
  return values
    .map((v) => `<line class="rw-grid${v === 0 ? " rw-zero" : ""}" x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/><text class="rw-axis" x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`)
    .join("");
}

function arc(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(r1, a0);
  const [x1, y1] = p(r1, a1);
  const [x2, y2] = p(r0, a1);
  const [x3, y3] = p(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

/** Squarified treemap: rectangles close to square, biggest first. */
function treemap(items, x, y, w, h) {
  const total = sum(items.map((i) => i.value));
  const queue = items.map((i) => ({ ...i, area: (i.value / total) * w * h }));
  const out = [];
  const worst = (row, side) => {
    const s = sum(row.map((r) => r.area));
    const max = Math.max(...row.map((r) => r.area));
    const min = Math.min(...row.map((r) => r.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const place = (row) => {
    const s = sum(row.map((r) => r.area));
    if (w >= h) {
      const rw = s / h;
      let cy = y;
      for (const r of row) out.push({ ...r, x, y: cy, w: rw, h: r.area / rw }), (cy += r.area / rw);
      x += rw;
      w -= rw;
    } else {
      const rh = s / w;
      let cx = x;
      for (const r of row) out.push({ ...r, x: cx, y, w: r.area / rh, h: rh }), (cx += r.area / rh);
      y += rh;
      h -= rh;
    }
  };
  let row = [];
  while (queue.length) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, queue[0]], side) <= worst(row, side)) row.push(queue.shift());
    else place(row), (row = []);
  }
  if (row.length) place(row);
  return out;
}

/* ---------- The reports ---------- */

const REPORTS = {
  category: {
    title: "Spending by category",
    sub: "Where your money went, by group.",
    range: "months",
    render(n, W) {
      const months = lastMonths(n);
      const groups = GROUPS.map((g) => ({ name: g.name, color: g.color, value: cents(sum(months.map((m) => DATA.spend[m][g.name]))) }))
        .filter((g) => g.value > 0)
        .sort((a, b) => b.value - a.value);
      const total = sum(groups.map((g) => g.value));
      const narrow = W < 620;
      const H = narrow ? 420 : 300;
      const r1 = narrow ? 92 : 112;
      const cx = narrow ? W / 2 : r1 + 16;
      const cy = narrow ? r1 + 10 : H / 2;
      let a = 0;
      const segments = groups
        .map((g, i) => {
          const a0 = a;
          a += (g.value / total) * Math.PI * 2;
          return `<path class="rw-seg" data-i="${i}" fill="${g.color}" d="${arc(cx, cy, r1 * 0.62, r1, a0 + 0.012, a - 0.012)}" data-tip="${esc(`${g.name}: ${money(g.value)} · ${pct(g.value / total)}`)}"/>`;
        })
        .join("");
      const center = `<text class="rw-donut-big" x="${cx}" y="${cy + 2}" text-anchor="middle">${money(total, 0)}</text><text class="rw-axis" x="${cx}" y="${cy + 22}" text-anchor="middle">spent</text>`;
      const left = narrow ? 16 : cx + r1 + 40;
      const top = narrow ? cy + r1 + 30 : 34;
      const rowH = narrow ? 32 : 40;
      const barW = W - left - (narrow ? 84 : 150);
      const max = groups[0].value;
      const rows = groups
        .map((g, i) => {
          const y0 = top + i * rowH;
          return `<g class="rw-row" data-i="${i}" data-tip="${esc(`${g.name}: ${money(g.value)} · ${pct(g.value / total)}`)}">
            <rect class="rw-hit" x="${left - 8}" y="${y0 - 16}" width="${W - left}" height="${rowH}"/>
            <circle cx="${left + 5}" cy="${y0 - 4}" r="5" fill="${g.color}"/>
            <text class="rw-label" x="${left + 18}" y="${y0}">${g.name}</text>
            <rect class="rw-track" x="${left + 110}" y="${y0 - 9}" width="${Math.max(10, barW - 110)}" height="8" rx="4"/>
            <rect fill="${g.color}" x="${left + 110}" y="${y0 - 9}" width="${Math.max(3, ((barW - 110) * g.value) / max)}" height="8" rx="4"/>
            ${narrow ? `<text class="rw-num" x="${W - 16}" y="${y0}" text-anchor="end">${money(g.value, 0)}</text>` : `<text class="rw-num" x="${W - 70}" y="${y0}" text-anchor="end">${money(g.value)}</text><text class="rw-axis" x="${W - 16}" y="${y0}" text-anchor="end">${pct(g.value / total)}</text>`}
          </g>`;
        })
        .join("");
      return {
        kpis: [
          ["Spent", money(total), `last ${n} months`],
          ["Monthly average", money(total / n), "across all groups"],
          ["Biggest group", groups[0].name, `${money(groups[0].value)} · ${pct(groups[0].value / total)}`],
          ["Groups with spending", String(groups.length), "of 6"],
        ],
        svg: `<svg viewBox="0 0 ${W} ${narrow ? top + groups.length * rowH : H}" width="${W}" height="${narrow ? top + groups.length * rowH : H}" class="rw-svg rw-linked">${segments}${center}${rows}</svg>`,
        table: [["Group", "Spent", "Share"], ...groups.map((g) => [g.name, money(g.value), pct(g.value / total)])],
      };
    },
  },

  payee: {
    title: "Spending by payee",
    sub: "Bigger tiles mean more spent. The top 14 payees.",
    range: "months",
    render(n, W) {
      const months = lastMonths(n);
      const all = [...DATA.payees].map(([name, p]) => ({
        name,
        value: cents(sum(months.map((m) => p.amount[m]))),
        count: sum(months.map((m) => p.count[m])),
      }));
      const total = sum(all.map((p) => p.value));
      const top = all.filter((p) => p.value > 0).sort((a, b) => b.value - a.value).slice(0, 14);
      const H = W < 620 ? 360 : 300;
      const palette = ["#7c5cff", "#1f9d6b", "#2f7fe0", "#ef8a2e", "#e5566a", "#d9a400", "#8b7dff", "#3fb68b"];
      const tiles = treemap(top, 0, 0, W, H)
        .map((t, i) => {
          const fits = t.w > 70 && t.h > 38;
          return `<g data-tip="${esc(`${t.name}: ${money(t.value)} · ${t.count} purchases`)}">
            <rect class="rw-tile" x="${t.x + 1.5}" y="${t.y + 1.5}" width="${Math.max(0, t.w - 3)}" height="${Math.max(0, t.h - 3)}" rx="7" fill="${palette[i % palette.length]}" style="--o: ${1 - i * 0.035}"/>
            ${fits ? `<text class="rw-tile-name" x="${t.x + 10}" y="${t.y + 22}">${esc(t.name.length * 7 > t.w - 16 ? t.name.slice(0, Math.max(3, Math.floor((t.w - 24) / 7))) + "…" : t.name)}</text><text class="rw-tile-num" x="${t.x + 10}" y="${t.y + 40}">${compact(t.value)}</text>` : ""}
          </g>`;
        })
        .join("");
      const purchases = sum(all.map((p) => p.count));
      const top5 = sum(top.slice(0, 5).map((p) => p.value));
      return {
        kpis: [
          ["Top payee", top[0].name, money(top[0].value)],
          ["Average purchase", money(total / purchases), `${purchases} purchases`],
          ["Top five payees", pct(top5 / total), "of all spending"],
          ["Payees", String(all.filter((p) => p.value > 0).length), `last ${n} months`],
        ],
        svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="rw-svg">${tiles}</svg>`,
        table: [["Payee", "Spent", "Purchases"], ...top.map((p) => [p.name, money(p.value), String(p.count)])],
      };
    },
  },

  income: {
    title: "Income vs. expense",
    sub: "What came in, what went out, and what was left.",
    range: "months",
    render(n, W) {
      const months = lastMonths(n);
      const rows = months.map((m) => {
        const spent = cents(sum(Object.values(DATA.spend[m])));
        return { m, income: INCOME[m], spent, net: cents(INCOME[m] - spent) };
      });
      const H = 300;
      const pad = { l: 56, r: 16, t: 16, b: 32 };
      const max = Math.max(...rows.map((r) => Math.max(r.income, r.spent)));
      const min = Math.min(0, ...rows.map((r) => r.net));
      const tv = ticks(min, max);
      const y = (v) => pad.t + ((tv.at(-1) - v) / (tv.at(-1) - tv[0])) * (H - pad.t - pad.b);
      const band = (W - pad.l - pad.r) / rows.length;
      const bw = Math.min(26, band * 0.32);
      const bars = rows
        .map((r, i) => {
          const x = pad.l + band * i + band / 2;
          return `<g data-tip="${esc(`${monthLabel(r.m)} · in ${money(r.income)} · out ${money(r.spent)} · left ${money(r.net)}`)}">
            <rect class="rw-hit" x="${x - band / 2}" y="${pad.t}" width="${band}" height="${H - pad.t - pad.b}"/>
            <rect fill="#1f9d6b" x="${x - bw - 1}" y="${y(r.income)}" width="${bw}" height="${y(0) - y(r.income)}" rx="3"/>
            <rect fill="#e5566a" x="${x + 1}" y="${y(r.spent)}" width="${bw}" height="${y(0) - y(r.spent)}" rx="3"/>
            <text class="rw-axis" x="${x}" y="${H - 10}" text-anchor="middle">${MONTHS[r.m]}</text>
          </g>`;
        })
        .join("");
      const line = rows.map((r, i) => `${pad.l + band * i + band / 2},${y(r.net)}`).join(" ");
      const income = sum(rows.map((r) => r.income));
      const spent = sum(rows.map((r) => r.spent));
      return {
        kpis: [
          ["Income", money(income), `last ${n} months`],
          ["Spending", money(spent), `${money(spent / n)} a month`],
          ["Net income", money(income - spent), "what was left"],
          ["Savings rate", pct((income - spent) / income), "of income kept"],
        ],
        svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="rw-svg">${grid(tv, y, pad.l, W - pad.r)}${bars}<polyline class="rw-line" points="${line}"/>${rows.map((r, i) => `<circle class="rw-dot" cx="${pad.l + band * i + band / 2}" cy="${y(r.net)}" r="3.5"/>`).join("")}</svg>`,
        legend: [["#1f9d6b", "Income"], ["#e5566a", "Spending"], ["var(--rw-accent)", "Net income", "line"]],
        table: [["Month", "Income", "Spending", "Net"], ...rows.map((r) => [monthLabel(r.m), money(r.income), money(r.spent), money(r.net)])],
      };
    },
  },

  networth: {
    title: "Net worth",
    sub: "What you own minus what you owe, at the end of each month.",
    range: "months",
    render(n, W) {
      const months = lastMonths(n);
      const rows = months.map((m) => ({ m, ...DATA.worth[m], net: cents(DATA.worth[m].assets - DATA.worth[m].debts) }));
      const H = 300;
      const pad = { l: 56, r: 16, t: 16, b: 32 };
      const max = Math.max(...rows.map((r) => r.assets));
      const min = -Math.max(...rows.map((r) => r.debts));
      const tv = ticks(min, max);
      const y = (v) => pad.t + ((tv.at(-1) - v) / (tv.at(-1) - tv[0])) * (H - pad.t - pad.b);
      const band = (W - pad.l - pad.r) / rows.length;
      const bw = Math.min(34, band * 0.55);
      const bars = rows
        .map((r, i) => {
          const x = pad.l + band * i + band / 2;
          return `<g data-tip="${esc(`${monthLabel(r.m)} · net worth ${money(r.net)} · assets ${money(r.assets)} · debts ${money(r.debts)}`)}">
            <rect class="rw-hit" x="${x - band / 2}" y="${pad.t}" width="${band}" height="${H - pad.t - pad.b}"/>
            <rect fill="#1f9d6b" opacity="0.85" x="${x - bw / 2}" y="${y(r.assets)}" width="${bw}" height="${y(0) - y(r.assets)}" rx="3"/>
            <rect fill="#e5566a" opacity="0.85" x="${x - bw / 2}" y="${y(0)}" width="${bw}" height="${y(-r.debts) - y(0)}" rx="3"/>
            <text class="rw-axis" x="${x}" y="${H - 10}" text-anchor="middle">${MONTHS[r.m]}</text>
          </g>`;
        })
        .join("");
      const line = rows.map((r, i) => `${pad.l + band * i + band / 2},${y(r.net)}`).join(" ");
      const first = rows[0];
      const last = rows.at(-1);
      const change = cents(last.net - (DATA.worth[months[0] - 1] ? DATA.worth[months[0] - 1].assets - DATA.worth[months[0] - 1].debts : first.net));
      return {
        kpis: [
          ["Net worth", money(last.net), `end of ${monthLabel(last.m)}`],
          ["Change", `${change >= 0 ? "+" : "−"}${money(Math.abs(change))}`, `over ${n} months`],
          ["Assets", money(last.assets), "cash, savings, investments"],
          ["Debts", money(last.debts), "car loan and cards"],
        ],
        svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="rw-svg">${grid(tv, y, pad.l, W - pad.r)}${bars}<polyline class="rw-line" points="${line}"/>${rows.map((r, i) => `<circle class="rw-dot" cx="${pad.l + band * i + band / 2}" cy="${y(r.net)}" r="3.5"/>`).join("")}</svg>`,
        legend: [["#1f9d6b", "Assets"], ["#e5566a", "Debts"], ["var(--rw-accent)", "Net worth", "line"]],
        table: [["Month", "Assets", "Debts", "Net worth"], ...rows.map((r) => [monthLabel(r.m), money(r.assets), money(r.debts), money(r.net)])],
      };
    },
  },

  forecast: {
    title: "Forecast",
    sub: "Where your cash is heading, from what's scheduled.",
    range: "ahead",
    render(n, W) {
      // Daily balances from today, October 16, 2026: scheduled transactions, plus an
      // everyday-spending allowance for the "forecast" line.
      const scheduled = [
        [1, 3850, "Payroll"], [15, 3850, "Payroll"], [1, -1950, "Rent"], [5, -900, "Childcare"], [5, -300, "School"],
        [10, -420, "Car loan"], [12, -210, "Health insurance"], [20, -95, "Car insurance"], [18, -70, "Internet"],
        [22, -85, "Mobile phones"], [3, -45, "Gym"], [14, -35, "Netflix"], [25, -140, "Electricity"], [25, -48, "Water"],
      ];
      const start = new Date(2026, 9, 16);
      const days = Math.round((new Date(2026, 9 + n, 16) - start) / 86400000);
      let known = 41099.2;
      let forecast = known;
      let moneyIn = 0;
      let moneyOut = 0;
      const points = [];
      for (let d = 0; d <= days; d++) {
        const date = new Date(2026, 9, 16 + d);
        if (d > 0) {
          for (const [day, amount] of scheduled) {
            if (date.getDate() === day) {
              known += amount;
              forecast += amount;
              if (amount > 0) moneyIn += amount;
              else moneyOut -= amount;
            }
          }
          forecast -= 76.4 + (date.getDay() === 6 ? 60 : 0);
        }
        points.push({ date, known: cents(known), forecast: cents(forecast) });
      }
      const H = 300;
      const pad = { l: 56, r: 76, t: 16, b: 32 };
      const values = points.flatMap((p) => [p.known, p.forecast]);
      const tv = ticks(Math.min(0, ...values), Math.max(...values));
      const y = (v) => pad.t + ((tv.at(-1) - v) / (tv.at(-1) - tv[0])) * (H - pad.t - pad.b);
      const x = (i) => pad.l + (i / days) * (W - pad.l - pad.r);
      const path = (key) => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join("");
      const low = points.reduce((a, p) => (p.forecast < a.forecast ? p : a), points[0]);
      const lowI = points.indexOf(low);
      const end = points.at(-1);
      const monthTicks = points
        .map((p, i) => [p, i])
        .filter(([p]) => p.date.getDate() === 1)
        .filter((_, k, list) => list.length <= 7 || k % 2 === 0)
        .map(([p, i]) => `<text class="rw-axis" x="${x(i)}" y="${H - 10}" text-anchor="middle">${p.date.toLocaleDateString("en-US", { month: "short" })}</text>`)
        .join("");
      const area = `${path("forecast")}L${x(days)} ${y(tv[0])}L${x(0)} ${y(tv[0])}Z`;
      const fmtDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return {
        kpis: [
          ["Today", money(points[0].forecast), "in 6 budget accounts"],
          ["Lowest point", money(low.forecast), fmtDate(low.date)],
          [`In ${n} months`, money(end.forecast), `${end.forecast >= points[0].forecast ? "+" : "−"}${money(Math.abs(end.forecast - points[0].forecast))} from today`],
          ["Known money in", money(moneyIn), "scheduled"],
          ["Known money out", money(moneyOut), "scheduled"],
        ],
        svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="rw-svg rw-forecast" data-days="${days}" data-left="${pad.l}" data-right="${W - pad.r}">
          <defs><linearGradient id="rw-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2f7fe0" stop-opacity="0.22"/><stop offset="1" stop-color="#2f7fe0" stop-opacity="0"/></linearGradient></defs>
          ${grid(tv, y, pad.l, W - pad.r)}
          <path d="${area}" fill="url(#rw-fill)"/>
          <path class="rw-known" d="${path("known")}"/>
          <path class="rw-fc" d="${path("forecast")}"/>
          <circle class="rw-low" cx="${x(lowI)}" cy="${y(low.forecast)}" r="4"/>
          <text class="rw-end" x="${x(days) + 8}" y="${y(end.known) + 4}">${compact(end.known)}</text>
          <text class="rw-end rw-end-fc" x="${x(days) + 8}" y="${y(end.forecast) + 4}">${compact(end.forecast)}</text>
          ${monthTicks}
          <line class="rw-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
        </svg>`,
        series: points.map((p) => [fmtDate(p.date), p.forecast, p.known]),
        legend: [["#2f7fe0", "Forecast", "line"], ["#ef8a2e", "Known transactions only", "dash"]],
        table: [["Month start", "Forecast", "Known only"], ...points.filter((p) => p.date.getDate() === 1).map((p) => [fmtDate(p.date), money(p.forecast), money(p.known)])],
      };
    },
  },
};

/* ---------- The widget ---------- */

export function reports() {
  const root = document.querySelector("[data-reports]");
  if (!root) return;
  const buttons = [...root.querySelectorAll("[data-report]")];
  const ranges = [...root.querySelectorAll("[data-range]")];
  const title = root.querySelector("[data-rw-title]");
  const sub = root.querySelector("[data-rw-sub]");
  const kpis = root.querySelector("[data-rw-kpis]");
  const chart = root.querySelector("[data-rw-chart]");
  const legend = root.querySelector("[data-rw-legend]");
  const table = root.querySelector("[data-rw-table]");
  const tip = root.querySelector("[data-rw-tip]");
  let current = "category";
  let months = 12;
  let series = null;

  const draw = () => {
    const report = REPORTS[current];
    const W = Math.max(300, Math.floor(chart.clientWidth));
    const out = report.render(months, W);
    title.textContent = report.title;
    sub.textContent = report.sub;
    for (const r of ranges) {
      r.setAttribute("aria-pressed", String(Number(r.dataset.range) === months));
          }
    kpis.innerHTML = out.kpis.map(([label, value, note]) => `<div class="rw-kpi"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small></div>`).join("");
    kpis.style.setProperty("--cols", out.kpis.length);
    chart.innerHTML = out.svg;
    chart.querySelector("svg")?.setAttribute("aria-hidden", "true");
    legend.innerHTML = (out.legend ?? [])
      .map(([color, label, kind]) => `<span class="rw-legend-item"><span class="rw-key rw-key-${kind ?? "box"}" style="--k: ${color}"></span>${esc(label)}</span>`)
      .join("");
    const [head, ...rows] = out.table;
    table.innerHTML = `<caption>${esc(report.title)}, ${months} months${report.range === "ahead" ? " ahead" : ""}</caption><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join("")}</tr>`).join("")}</tbody>`;
    series = out.series ?? null;
    tip.hidden = true;
  };

  const select = (name) => {
    current = name;
    for (const b of buttons) b.setAttribute("aria-current", String(b.dataset.report === name));
    draw();
  };

  const setRange = (n) => {
    months = n;
    draw();
  };

  for (const b of buttons) b.addEventListener("click", () => select(b.dataset.report));
  for (const r of ranges) r.addEventListener("click", () => setRange(Number(r.dataset.range)));

  // Hover readouts: anything with data-tip, or the nearest day on the forecast.
  const place = (event, text) => {
    tip.textContent = text;
    tip.hidden = false;
    const box = tip.offsetParent.getBoundingClientRect();
    const x = Math.min(box.width - tip.offsetWidth - 8, Math.max(8, event.clientX - box.left + 14));
    const y = Math.max(8, event.clientY - box.top - tip.offsetHeight - 12);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  };
  const hover = (event) => {
    const svg = chart.querySelector("svg");
    if (!svg) return;
    if (svg.classList.contains("rw-forecast") && series) {
      const box = svg.getBoundingClientRect();
      const left = Number(svg.dataset.left);
      const right = Number(svg.dataset.right);
      const px = ((event.clientX - box.left) / box.width) * Number(svg.viewBox.baseVal.width);
      const i = Math.round(((px - left) / (right - left)) * Number(svg.dataset.days));
      const cross = svg.querySelector(".rw-cross");
      if (i < 0 || i > series.length - 1) {
        cross.setAttribute("visibility", "hidden");
        tip.hidden = true;
        return;
      }
      const cx = left + (i / Number(svg.dataset.days)) * (right - left);
      cross.setAttribute("x1", cx);
      cross.setAttribute("x2", cx);
      cross.setAttribute("visibility", "visible");
      const [date, forecast, known] = series[i];
      place(event, `${date} · forecast ${money(forecast)} · known only ${money(known)}`);
      return;
    }
    const target = event.target.closest("[data-tip]");
    svg.querySelectorAll(".is-hot").forEach((el) => el.classList.remove("is-hot"));
    if (!target) {
      tip.hidden = true;
      return;
    }
    if (target.dataset.i !== undefined) svg.querySelectorAll(`[data-i="${target.dataset.i}"]`).forEach((el) => el.classList.add("is-hot"));
    else target.classList.add("is-hot");
    place(event, target.dataset.tip);
  };
  // A tap on a phone shows the same readout.
  chart.addEventListener("pointermove", hover);
  chart.addEventListener("pointerdown", hover);
  chart.addEventListener("pointerleave", () => {
    tip.hidden = true;
    const svg = chart.querySelector("svg");
    svg?.querySelectorAll(".is-hot").forEach((el) => el.classList.remove("is-hot"));
    svg?.querySelector(".rw-cross")?.setAttribute("visibility", "hidden");
  });

  root.classList.add("is-live");
  select(current);
  let width = chart.clientWidth;
  new ResizeObserver(() => {
    if (Math.abs(chart.clientWidth - width) < 2) return;
    width = chart.clientWidth;
    draw();
  }).observe(chart);

  // The cursor opens Net worth, then points at the latest month on screen so its readout shows. On
  // a phone, where the reports are a sideways row that may not show those, it changes the date
  // range instead.
  showOnce(root, "reports", () => {
    if (current !== "category") return null;
    const report = ["networth", "income", "payee"].map((name) => buttons.find((b) => b.dataset.report === name)).find((b) => b && inView(b));
    const range = ranges.find((r) => Number(r.dataset.range) !== months && inView(r));
    const target = report ?? range;
    if (!target) return null;
    return {
      target,
      fx: report ? 0.3 : 0.5,
      act: () => (report ? select(report.dataset.report) : setRange(Number(range.dataset.range))),
      next: () => [...chart.querySelectorAll("[data-tip]")].filter(inView).at(-1),
      nextFy: 0.4,
      arrive: ([x, y], el) => el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y })),
      leave: () => chart.dispatchEvent(new PointerEvent("pointerleave")),
    };
  });
}
