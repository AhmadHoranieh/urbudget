// The debt snowball and avalanche calculator on /tools/debt-payoff-calculator/. It pays several
// debts from one fixed monthly amount, in whole cents, with the same interest rule as the loan and
// card calculators (payoff.js): a month's interest is the balance × the APR ÷ 12, rounded to the
// cent. It all runs here in the browser; nothing typed is sent anywhere.
//
// Each month, in this order:
//   1. Interest: every debt that still owes money is charged balance × APR ÷ 12, to the cent
//      (monthlyInterest), and that's added to what it owes.
//   2. Minimums: every debt is paid its minimum, or what it now owes if that's less.
//   3. The rest: whatever is left of the monthly amount (plus, in the first month only, the
//      one-time extra) goes to the target, the first debt in the strategy's order that still owes
//      money, up to what it owes. If that pays it off, what's still left goes to the next debt in
//      the order, and so on.
//   4. Rollover: the monthly amount stays the same, so once a debt is paid off (or owes less than
//      its minimum), the part of its minimum it no longer needs is part of what's left in step 3
//      and goes to the target. That's the snowball effect.
// The order is set once, from the starting balances and APRs:
//   avalanche: highest APR first; equal APRs, smaller balance first;
//   snowball: smallest balance first; equal balances, higher APR first;
//   anything still equal keeps the order the debts were entered in.
// "Minimums only", for comparison, pays each debt its minimum (or what it owes) and nothing else:
// the monthly amount is the sum of the minimums, and a paid-off debt's minimum is not paid to
// anything, so the total paid falls as debts are paid off.
//
// Assumptions: each minimum is a fixed amount, the one entered. Real credit card minimums are
// worked out again on every statement and shrink as the balance falls (payoff.js projectMinimum
// does that for one card), so paying only a card's real minimum takes longer than shown here.
// APRs don't change, nothing new is borrowed or charged, there are no fees, and interest is
// charged monthly, not daily. A debt with no balance is already paid off; its minimum goes to the
// plan from the first month.
//
// Amounts are in cents and rates in thousandths of a percent (22.9% = 22900), as in payoff.js.
//
// A page provides #debts-form (a #debts-list of [data-debt] fieldsets, each with inputs whose
// data-key is name, balance, rate or minimum; #monthly, #extra, #start, radio inputs named
// strategy, a submit button and a [data-add-debt] button), #debts-results (an aria-live region)
// and #debts-schedule (a <details> with a [data-schedule] body). Without JavaScript, the buttons
// stay disabled and the worked example written into the page stays as it is.

import { MAX_MONTHS, duration, money, monthName, monthValue, monthlyInterest, parseMoney, parseMonth, parseRate } from "./payoff.js";

/** The page lets you enter up to 10 debts. */
export const MAX_DEBTS = 10;
/** $10 billion, the limit for any amount (as in payoff.js). */
const MAX_CENTS = 1_000_000_000_000;
/** 1,000%, in thousandths of a percent. */
const MAX_RATE = 1_000_000;

export const STRATEGIES = {
  snowball: "Snowball: smallest balance first",
  avalanche: "Avalanche: highest APR first",
};

// ---------- Math ----------

const isAmount = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_CENTS;
const sum = (list) => list.reduce((a, b) => a + b, 0);

/** Returns an error for input the plan can't run on, or null. */
function invalid(debts, monthly, extra) {
  if (!Array.isArray(debts)) return { error: "bad-input", field: "debts" };
  if (!debts.length) return { error: "no-debts" };
  for (const [index, d] of debts.entries()) {
    if (!d || !isAmount(d.balance)) return { error: "bad-input", field: "balance", index };
    if (!(Number.isInteger(d.rate) && d.rate >= 0 && d.rate <= MAX_RATE)) return { error: "bad-input", field: "rate", index };
    if (!isAmount(d.minimum)) return { error: "bad-input", field: "minimum", index };
  }
  if (!isAmount(monthly)) return { error: "bad-input", field: "monthly" };
  if (!isAmount(extra)) return { error: "bad-input", field: "extra" };
  if (debts.every((d) => d.balance === 0)) return { error: "no-debts" };
  return null;
}

/**
 * The order a strategy puts extra money on the debts that have a balance: indexes into debts.
 * strategy is "avalanche" or "snowball".
 */
export function priority(debts, strategy) {
  const rate = (a, b) => debts[b].rate - debts[a].rate;
  const balance = (a, b) => debts[a].balance - debts[b].balance;
  const compare = strategy === "snowball"
    ? (a, b) => balance(a, b) || rate(a, b) || a - b
    : (a, b) => rate(a, b) || balance(a, b) || a - b;
  return debts.map((_, i) => i).filter((i) => debts[i].balance > 0).sort(compare);
}

/**
 * Runs the months. With `order`, what's left after the minimums goes down that list (steps 3
 * and 4 above); without it, only the minimums are paid.
 */
function run(debts, { monthly, extra = 0, order = null }) {
  const n = debts.length;
  const owed = debts.map((d) => d.balance);
  const month = debts.map((d) => (d.balance > 0 ? null : 0));
  const interest = new Array(n).fill(0);
  const paid = new Array(n).fill(0);
  const schedule = [];
  while (owed.some((b) => b > 0)) {
    if (schedule.length >= MAX_MONTHS) return { error: "too-long" };
    const number = schedule.length + 1;
    const charge = owed.map((b, i) => (b > 0 ? monthlyInterest(b, debts[i].rate) : 0));
    const due = owed.map((b, i) => b + charge[i]);
    const pay = due.map((d, i) => Math.min(debts[i].minimum, d));
    const most = monthly + (number === 1 ? extra : 0);
    if (order) {
      let left = most - sum(pay);
      for (const i of order) {
        if (left <= 0) break;
        const more = Math.min(left, due[i] - pay[i]);
        pay[i] += more;
        left -= more;
      }
    }
    // Debts that still owe money after this month and didn't go down.
    const stuck = owed
      .map((b, i) => i)
      .filter((i) => owed[i] > 0 && pay[i] < due[i] && pay[i] <= charge[i]);
    const owing = owed.filter((b) => b > 0).length;
    // Without the rollover a debt's payment never grows, and with it, a month where no debt is paid
    // off and none goes down repeats forever: next month the same payments meet the same or more
    // interest. A debt charged at least the most anything can be paid in a month never goes down.
    const never = !order || stuck.length === owing ? stuck : stuck.filter((i) => charge[i] >= most);
    if (never.length) {
      return {
        error: "never",
        month: number,
        stuck: never.map((index) => ({ index, payment: pay[index], interest: charge[index] })),
      };
    }
    for (let i = 0; i < n; i++) {
      if (owed[i] <= 0) continue;
      owed[i] = due[i] - pay[i];
      interest[i] += charge[i];
      paid[i] += pay[i];
      if (owed[i] === 0) month[i] = number;
    }
    schedule.push({ payments: pay, interest: charge, balances: [...owed] });
  }
  const position = new Map((order ?? []).map((i, at) => [i, at]));
  const paidOff = debts
    .map((_, i) => i)
    .filter((i) => debts[i].balance > 0)
    .sort((a, b) => month[a] - month[b] || (position.get(a) ?? a) - (position.get(b) ?? b));
  return {
    months: schedule.length,
    totalInterest: sum(interest),
    totalPaid: sum(paid),
    order: paidOff,
    debts: debts.map((_, i) => ({ month: month[i], interest: interest[i], paid: paid[i] })),
    schedule,
  };
}

/**
 * Pays the debts off with one fixed monthly amount and a strategy, as described at the top.
 * debts: [{ balance, rate, minimum }] (a name is carried along but not used); monthly and the
 * one-time extra in cents; strategy "avalanche" or "snowball".
 *
 * Returns { months, totalInterest, totalPaid, priority, order, debts, schedule }:
 *   priority: the strategy's order (indexes of the debts with a balance);
 *   order: the same debts in the order they're paid off;
 *   debts[i]: { month, interest, paid }, month being the payment number that paid it off
 *     (0 for a debt with no balance);
 *   schedule[m]: { payments, interest, balances }, one entry per debt, for month m + 1.
 * Or an error:
 *   { error: "no-debts" }: no debts, or none with a balance;
 *   { error: "bad-input", field, index? }: an amount that isn't whole cents from 0 to $10 billion,
 *     a rate outside 0 to 1,000%, or an unknown strategy;
 *   { error: "short", needed }: the monthly amount is less than the minimums of the debts with a
 *     balance, which add up to `needed`;
 *   { error: "never", month, stuck: [{ index, payment, interest }] }: from that month on, those
 *     debts are paid no more than their interest and the plan can never pay them more;
 *   { error: "too-long" }: more than 100 years (MAX_MONTHS).
 */
export function plan({ debts, monthly, strategy = "avalanche", extra = 0 }) {
  const bad = invalid(debts, monthly, extra);
  if (bad) return bad;
  if (!(strategy in STRATEGIES)) return { error: "bad-input", field: "strategy" };
  const needed = sum(debts.filter((d) => d.balance > 0).map((d) => d.minimum));
  if (monthly < needed) return { error: "short", needed };
  const order = priority(debts, strategy);
  const result = run(debts, { monthly, extra, order });
  return result.error ? result : { ...result, priority: order };
}

/**
 * Pays each debt only its minimum, with no rollover: the comparison for a plan. Returns what plan
 * returns (with `first`, the first month's total) or an error; "never" names the debts whose
 * minimum doesn't cover their interest.
 */
export function minimumsOnly(debts) {
  const bad = invalid(debts, 0, 0);
  if (bad) return bad;
  const result = run(debts, { monthly: 0 });
  if (result.error) return result;
  return { ...result, priority: [], first: sum(result.schedule[0].payments) };
}

/** Both strategies and paying only the minimums, for the same debts; `same` when the orders match. */
export function compare({ debts, monthly, extra = 0 }) {
  const snowball = plan({ debts, monthly, extra, strategy: "snowball" });
  const avalanche = plan({ debts, monthly, extra, strategy: "avalanche" });
  const minimums = minimumsOnly(debts);
  const same = !snowball.error && !avalanche.error && snowball.priority.join() === avalanche.priority.join();
  return { snowball, avalanche, minimums, same };
}

// ---------- Results ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Text typed into the form, safe to put in HTML. */
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const label = (strategy) => (strategy === "snowball" ? "snowball" : "avalanche");
/** "Visa", "Visa and Car loan", "Visa, Store card and Car loan". */
const names = (list) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

function stats(run, start) {
  const span = run.months >= 12 ? ` <span>(${duration(run.months)})</span>` : "";
  return `<dl class="calc-stats">
  <div><dt>Months to debt-free</dt><dd>${run.months}${span}</dd></div>
  <div><dt>Debt-free month</dt><dd>${monthName(start + run.months - 1)}</dd></div>
  <div><dt>Total interest</dt><dd>${money(run.totalInterest)}</dd></div>
  <div><dt>Total paid</dt><dd>${money(run.totalPaid)}</dd></div>
</dl>`;
}

function problem(run, debts, start, monthly, minimums = false) {
  if (run.error === "too-long") {
    return minimums
      ? `<p class="calc-problem">Paying only the minimums takes more than 100 years.</p>`
      : `<p class="calc-problem">At ${money(monthly)} a month, this takes more than 100 years. Pay more each month.</p>`;
  }
  const one = run.stuck.length === 1;
  const when = run.month > 1 ? `from ${monthName(start + run.month - 1)} ` : "";
  const parts = run.stuck.map(
    (s) => `${one ? "it's" : `${escapeHtml(debts[s.index].name)} is`} paid ${money(s.payment)} a month ${when}against ${money(s.interest)} of interest`,
  );
  const who = names(run.stuck.map((s) => escapeHtml(debts[s.index].name)));
  const why = `${parts.join("; ")}, so ${one ? "it never goes" : "they never go"} down.`;
  if (minimums) return `<p class="calc-problem">Paying only the minimums never pays off ${who}: ${why}</p>`;
  if (run.stuck.every((s) => s.interest >= monthly)) {
    // The interest alone takes the whole monthly amount, whatever goes to the other debts.
    const charges = run.stuck.map((s) => `${one ? "its" : `${escapeHtml(debts[s.index].name)}'s`} interest, ${money(s.interest)} a month,`);
    return `<p class="calc-problem">This never pays off ${who}: ${charges.join(" and ")} would take all of the ${money(monthly)} you pay each month. Pay more each month.</p>`;
  }
  return `<p class="calc-problem">This never pays off ${who}: ${why} Pay more each month.</p>`;
}

function card(strategy, run, debts, start, monthly, chosen) {
  const mark = chosen ? " <span>(your choice)</span>" : "";
  return `<section class="calc-card${chosen ? " is-extra" : ""}">
<h3>${STRATEGIES[strategy]}${mark}</h3>
${run.error ? problem(run, debts, start, monthly) : stats(run, start)}
</section>`;
}

/** What a plan does compared with paying only the minimums, as a verb phrase. */
function gain(run, least) {
  const months = least.months - run.months;
  const interest = least.totalInterest - run.totalInterest;
  if (months > 0 && interest > 0) return `gets you debt-free <b>${duration(months)} sooner</b> and saves <b>${money(interest)}</b> in interest`;
  if (months > 0) return `gets you debt-free <b>${duration(months)} sooner</b>`;
  if (interest > 0) return `saves <b>${money(interest)}</b> in interest, with the same debt-free month`;
  return "gives the same result";
}

function versusMinimums({ snowball, avalanche, minimums, same }) {
  const ok = [["snowball", snowball], ["avalanche", avalanche]].filter(([, run]) => !run.error);
  if (!ok.length) return "";
  if (minimums.error) {
    const which = ok.length === 2 ? "Either plan" : `The ${ok[0][0]} plan`;
    return `<p class="calc-saving">Paying only the minimums never clears everything. ${which} pays it all off.</p>`;
  }
  if (same || ok.length === 1) {
    const [name, run] = ok[0];
    return `<p class="calc-saving">Compared with paying only the minimums, ${same ? "either method" : name} ${gain(run, minimums)}.</p>`;
  }
  const months = minimums.months - snowball.months;
  const saved = (run) => minimums.totalInterest - run.totalInterest;
  if (months > 0 && months === minimums.months - avalanche.months && saved(snowball) > 0 && saved(avalanche) > 0) {
    return `<p class="calc-saving">Compared with paying only the minimums, both get you debt-free <b>${duration(months)} sooner</b>. Snowball saves <b>${money(saved(snowball))}</b> in interest; avalanche saves <b>${money(saved(avalanche))}</b>.</p>`;
  }
  return `<p class="calc-saving">Compared with paying only the minimums, snowball ${gain(snowball, minimums)}; avalanche ${gain(avalanche, minimums)}.</p>`;
}

function versusEachOther({ snowball, avalanche, same }, debts) {
  if (snowball.error || avalanche.error) return "";
  if (same) return `<p class="calc-note">Here both methods put the extra on the debts in the same order, so they give the same result.</p>`;
  const interest = snowball.totalInterest - avalanche.totalInterest;
  const months = snowball.months - avalanche.months;
  let text = interest > 0
    ? `Avalanche costs <b>${money(interest)} less</b> in interest than snowball`
    : interest < 0
      ? `Snowball costs <b>${money(-interest)} less</b> in interest than avalanche`
      : "Both cost the same in interest";
  text += months === 0
    ? ", and both are debt-free in the same month."
    : `, and ${months > 0 ? "avalanche" : "snowball"} is debt-free <b>${duration(Math.abs(months))} sooner</b>.`;
  const first = (run) => run.order[0];
  const a = first(snowball);
  const b = first(avalanche);
  if (a !== b || snowball.debts[a].month !== avalanche.debts[b].month) {
    text += ` Snowball pays off its first debt, ${escapeHtml(debts[a].name)}, in month ${snowball.debts[a].month}; avalanche pays off its first, ${escapeHtml(debts[b].name)}, in month ${avalanche.debts[b].month}.`;
  }
  return `<p class="calc-note">${text}</p>`;
}

function minimumsCard(run, debts, start) {
  const first = run.error ? "" : ` <span>(${money(run.first)} in the first month)</span>`;
  return `<div class="calc-cards is-single">
<section class="calc-card is-minimum">
<h3>Paying only the minimums${first}</h3>
${run.error ? problem(run, debts, start, 0, true) : stats(run, start)}
</section>
</div>`;
}

function payoffList(run, debts, start, strategy) {
  const focus = run.priority.map((i) => escapeHtml(debts[i].name));
  const lead = focus.length > 1
    ? `<p>The money left after the minimums goes to ${focus[0]} first, then ${focus.slice(1).join(", then ")}.</p>`
    : "";
  const items = run.order.map((i) => {
    const d = run.debts[i];
    return `<li><b>${escapeHtml(debts[i].name)}</b>: paid off in ${monthName(start + d.month - 1)} (month ${d.month}), ${money(d.interest)} in interest</li>`;
  });
  for (const [i, debt] of debts.entries()) {
    if (debt.balance > 0) continue;
    const rest = debt.minimum > 0 ? `, so its ${money(debt.minimum, true)} minimum goes to the plan from the first month` : "";
    items.push(`<li><b>${escapeHtml(debt.name)}</b>: nothing owed${rest}</li>`);
  }
  return `<h3 class="debts-heading">Payoff order with ${label(strategy)}</h3>
${lead}
<ol class="debts-order">
${items.join("\n")}
</ol>`;
}

/**
 * Everything the results region shows for a set of inputs: debts [{ name, balance, rate,
 * minimum }], monthly and extra in cents, strategy, and start, the month number of the first
 * payment. Returns { html, schedule, caption, csv } or, when no plan can run, { error } (the
 * error plan returns: "no-debts", "bad-input" or "short").
 */
export function calculate({ debts, monthly, extra = 0, strategy = "snowball" }, start) {
  const runs = compare({ debts, monthly, extra });
  const chosen = strategy in STRATEGIES ? runs[strategy] : { error: "bad-input", field: "strategy" };
  if (chosen.error && !["never", "too-long"].includes(chosen.error)) return { error: chosen };
  const html = `<div class="calc-cards">
${card("snowball", runs.snowball, debts, start, monthly, strategy === "snowball")}
${card("avalanche", runs.avalanche, debts, start, monthly, strategy === "avalanche")}
</div>
${versusEachOther(runs, debts)}
${minimumsCard(runs.minimums, debts, start)}
${versusMinimums(runs)}
${chosen.error ? "" : payoffList(chosen, debts, start, strategy)}`.replace(/\n{2,}/g, "\n");
  return {
    html,
    schedule: chosen.error ? "" : scheduleHtml(chosen, debts, start),
    csv: chosen.error ? "" : scheduleCsv(chosen, debts, start),
    caption: chosen.error ? "" : `Month-by-month schedule with ${label(strategy)} (${plural(chosen.months, "month")})`,
  };
}

/** For each month, the debts that owed something when it began. */
function monthsOf(run, debts) {
  let before = debts.map((d) => d.balance);
  return run.schedule.map((m) => {
    const rows = debts.map((_, i) => i).filter((i) => before[i] > 0);
    before = m.balances;
    return { m, rows };
  });
}

/** The month-by-month table: one row per debt that still owed money, grouped by month. */
export function scheduleHtml(run, debts, start) {
  const groups = monthsOf(run, debts).map(({ m, rows }, at) => {
    const lines = rows.map((i, k) => {
      const month = k === 0 ? `<th scope="rowgroup" rowspan="${rows.length}">${monthName(start + at, true)}</th>` : "";
      return `<tr>${month}<th scope="row">${escapeHtml(debts[i].name)}</th><td>${money(m.payments[i])}</td><td>${money(m.interest[i])}</td><td>${money(m.balances[i])}</td></tr>`;
    });
    return `<tbody>\n${lines.join("\n")}\n</tbody>`;
  });
  return `<table class="calc-table debts-table">
<thead><tr><th scope="col">Month</th><th scope="col">Debt</th><th scope="col">Payment</th><th scope="col">Interest</th><th scope="col">Balance</th></tr></thead>
${groups.join("\n")}
<tfoot><tr><th scope="row" colspan="2">Total</th><td>${money(run.totalPaid)}</td><td>${money(run.totalInterest)}</td><td></td></tr></tfoot>
</table>`;
}

/** The same schedule as a CSV file: month, debt, payment, interest, balance. */
export function scheduleCsv(run, debts, start) {
  const plain = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const quote = (text) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = ["Month,Debt,Payment,Interest,Balance"];
  for (const [at, { m, rows }] of monthsOf(run, debts).entries()) {
    for (const i of rows) {
      lines.push([monthValue(start + at), quote(debts[i].name), plain(m.payments[i]), plain(m.interest[i]), plain(m.balances[i])].join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}

// ---------- The page ----------

const KEYS = [
  ["name", "Name", ""],
  ["balance", "Balance", "decimal"],
  ["rate", "APR (%)", "decimal"],
  ["minimum", "Minimum", "decimal"],
];

function init() {
  const form = document.getElementById("debts-form");
  const list = document.getElementById("debts-list");
  const results = document.getElementById("debts-results");
  const details = document.getElementById("debts-schedule");
  if (!form || !list || !results) return;
  const field = (id) => document.getElementById(id);
  const summary = details?.querySelector("summary");
  const body = details?.querySelector("[data-schedule]");
  const add = form.querySelector("[data-add-debt]");
  const rows = () => [...list.querySelectorAll("[data-debt]")];

  // The first payment defaults to next month, unless the browser kept what was typed before.
  const now = new Date();
  const start = field("start");
  if (start && start.value === start.defaultValue) start.value = monthValue(now.getFullYear() * 12 + now.getMonth() + 1);

  const removeButton = () => {
    const button = document.createElement("button");
    button.className = "btn btn-sm btn-ghost debt-remove";
    button.type = "button";
    button.dataset.remove = "";
    button.textContent = "Remove";
    return button;
  };
  const renumber = () => {
    const all = rows();
    all.forEach((row, at) => {
      const n = at + 1;
      row.querySelector("legend").textContent = `Debt ${n}`;
      for (const input of row.querySelectorAll("input")) {
        input.id = `debt-${n}-${input.dataset.key}`;
        input.closest(".field").querySelector("label").htmlFor = input.id;
      }
      const remove = row.querySelector("[data-remove]");
      remove.setAttribute("aria-label", `Remove debt ${n}`);
      remove.hidden = all.length === 1;
    });
    if (add) add.disabled = all.length >= MAX_DEBTS;
  };
  for (const row of rows()) row.querySelector("legend").after(removeButton());
  // The buttons stay disabled in the HTML, so the form can't be sent anywhere without this script.
  for (const button of form.querySelectorAll("button")) button.disabled = false;
  renumber();

  /** Marks a field as wrong and ties the message, shown in the results, to it. */
  const fail = (input, message) => {
    if (input) {
      input.dataset.hint ??= input.getAttribute("aria-describedby") ?? "";
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", `${input.dataset.hint} debts-error`.trim());
    }
    results.innerHTML = `<p class="calc-problem" id="debts-error">${message}</p>`;
    if (details) details.hidden = true;
    return { input };
  };
  const clear = () => {
    for (const input of form.querySelectorAll("input[aria-invalid]")) {
      input.removeAttribute("aria-invalid");
      if (input.dataset.hint) input.setAttribute("aria-describedby", input.dataset.hint);
      else input.removeAttribute("aria-describedby");
    }
  };

  /** Reads the form; returns { values } or the field that's wrong, after showing why. */
  const read = () => {
    clear();
    const debts = [];
    for (const [at, row] of rows().entries()) {
      const input = (key) => row.querySelector(`[data-key="${key}"]`);
      const text = Object.fromEntries(KEYS.map(([key]) => [key, input(key).value.trim()]));
      if (!text.name && !text.balance && !text.rate && !text.minimum) continue; // an empty row
      const which = text.name ? escapeHtml(text.name) : `debt ${at + 1}`;
      const balance = parseMoney(text.balance);
      if (Number.isNaN(balance)) return fail(input("balance"), `Enter what you owe on ${which}, like 2400 or 2,400.50.`);
      const rate = parseRate(text.rate);
      if (Number.isNaN(rate)) return fail(input("rate"), `Enter the APR of ${which} as a percent from 0 to 1,000, like 24.99, or 0 if it charges no interest.`);
      const minimum = parseMoney(text.minimum);
      if (Number.isNaN(minimum)) return fail(input("minimum"), `Enter the minimum payment of ${which}, like 35, or 0 if it has none.`);
      debts.push({ name: text.name || `Debt ${at + 1}`, balance, rate, minimum });
    }
    const firstBalance = () => rows()[0]?.querySelector('[data-key="balance"]');
    if (!debts.some((d) => d.balance > 0)) return fail(firstBalance(), "Enter at least one debt with a balance above $0.");
    const monthly = parseMoney(field("monthly").value);
    if (Number.isNaN(monthly) || monthly === 0) return fail(field("monthly"), "Enter what you can pay toward these debts each month, like 900.");
    const extraText = field("extra").value.trim();
    const extra = extraText ? parseMoney(extraText) : 0;
    if (Number.isNaN(extra)) return fail(field("extra"), "Enter the one-time extra as an amount, like 1000, or leave it empty.");
    const first = parseMonth(start.value);
    if (Number.isNaN(first)) return fail(start, "Enter the month of your first payment, like 2026-11.");
    const strategy = form.querySelector('input[name="strategy"]:checked')?.value ?? "snowball";
    return { values: { debts, monthly, extra, strategy, start: first } };
  };

  let csv = "";
  const show = (focus = false) => {
    const { values, input } = read();
    if (!values) {
      if (focus) input?.focus();
      return;
    }
    const out = calculate(values, values.start);
    if (out.error) {
      const wrong = out.error.error === "short"
        ? fail(field("monthly"), `The minimums add up to ${money(out.error.needed)} a month, so the monthly amount has to be at least that.`)
        : fail(null, "Check the amounts above.");
      if (focus) wrong.input?.focus();
      return;
    }
    results.innerHTML = out.html;
    csv = out.csv;
    if (details && body && summary) {
      details.hidden = !out.schedule;
      body.innerHTML = out.schedule;
      summary.textContent = out.caption;
    }
  };

  // Add and remove debts.
  add?.addEventListener("click", () => {
    if (rows().length >= MAX_DEBTS) return;
    const row = document.createElement("fieldset");
    row.className = "debt-row";
    row.dataset.debt = "";
    row.innerHTML = `<legend></legend>
<div class="debt-fields">
${KEYS.map(([key, text, mode]) => `<div class="field debt-${key}"><label>${text}</label><input class="input" type="text"${mode ? ` inputmode="${mode}"` : ""} autocomplete="off" data-key="${key}"></div>`).join("\n")}
</div>`;
    row.querySelector("legend").after(removeButton());
    list.append(row);
    renumber();
    row.querySelector("input").focus();
  });
  list.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove]");
    if (!remove || rows().length < 2) return;
    const row = remove.closest("[data-debt]");
    const next = row.nextElementSibling ?? row.previousElementSibling;
    row.remove();
    renumber();
    (next?.querySelector("input") ?? add)?.focus();
    show();
  });

  // Download the listed schedule as a CSV file, or print it.
  if (details && body) {
    const actions = document.createElement("div");
    actions.className = "calc-schedule-actions";
    actions.innerHTML = `<button class="btn btn-sm" type="button" data-csv>Download CSV</button> <button class="btn btn-sm btn-ghost" type="button" data-print>Print</button>`;
    body.before(actions);
    actions.querySelector("[data-csv]").addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "debt-payoff-schedule.csv";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    actions.querySelector("[data-print]").addEventListener("click", () => {
      details.open = true;
      window.print();
    });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    show(true);
  });
  form.addEventListener("change", () => show());
  show();
}

if (typeof document !== "undefined") init();
