// The loan and credit card payoff calculators on /tools/. The math is UrBudget's own loan planner
// (desktop/src-tauri/src/loans.rs: interest, project, payment_by_date), in whole cents: each month
// the interest is the balance × the annual rate ÷ 12, rounded to the cent, fees are added, and then
// the payment is applied. It all runs here in the browser; nothing typed is sent anywhere.
//
// A page provides #payoff-form (inputs #balance, #rate, #payment, #extra, #start and #target, a
// submit button and a [data-find-payment] button), #payoff-results (an aria-live region) and
// #payoff-schedule (a <details> with a [data-schedule] body). A card page can add #min-percent,
// #min-floor and the #min-interest checkbox to compare paying only the minimum. Without
// JavaScript, the worked example written into the page stays as it is.

/** The app stops at 100 years of payments. */
export const MAX_MONTHS = 1200;
/** $10 billion, the app's limit for any amount. */
const MAX_CENTS = 1_000_000_000_000;
/** 1,000%, in thousandths of a percent. */
const MAX_RATE = 1_000_000;

// ---------- Math ----------

/**
 * One month's interest in cents: balance × annual rate ÷ 12, to the nearest cent (half up).
 * rate is the annual rate in thousandths of a percent (4.9% = 4900).
 */
export function monthlyInterest(balance, rate) {
  return Number((BigInt(balance) * BigInt(rate) + 600000n) / 1200000n);
}

/**
 * Pays a balance down month by month. All amounts in cents. `lumps` are one-time payments,
 * [{ month, amount }], where month counts payments from 0 (the first payment): a lump is paid with
 * that month's payment, after that month's interest, so interest from the next month on is charged
 * on the lower balance. Lumps for months after the balance is paid off aren't used. Returns
 * { months, totalInterest, totalFees, totalPaid, schedule } or, when it never ends,
 * { error: "too-small", charge } (a month's payment doesn't cover that month's interest and fees)
 * or { error: "too-long" } (more than 100 years).
 */
export function project({ balance, rate, payment, extra = 0, fees = 0, lumps = [] }) {
  const schedule = [];
  const lumpAt = new Map();
  for (const { month, amount } of lumps) lumpAt.set(month, (lumpAt.get(month) ?? 0) + amount);
  let owed = balance;
  let totalInterest = 0;
  let totalFees = 0;
  let totalPaid = 0;
  while (owed > 0) {
    if (schedule.length >= MAX_MONTHS) return { error: "too-long" };
    const charge = monthlyInterest(owed, rate);
    const paid = Math.min(payment + extra + (lumpAt.get(schedule.length) ?? 0), owed + charge + fees);
    if (paid <= charge + fees) return { error: "too-small", charge: charge + fees };
    const principal = paid - charge - fees;
    owed -= principal;
    schedule.push({ payment: paid, interest: charge, fees, principal, balance: owed });
    totalInterest += charge;
    totalFees += fees;
    totalPaid += paid;
  }
  return { months: schedule.length, totalInterest, totalFees, totalPaid, schedule };
}

/** The smallest monthly payment, in cents, that pays the balance off within `months` payments. */
export function paymentFor({ balance, rate, months, fees = 0 }) {
  if (balance <= 0) return 0;
  let low = 1;
  let high = balance + monthlyInterest(balance, rate) + fees;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const run = project({ balance, rate, payment: mid, fees });
    if (!run.error && run.months <= months) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Pays a card down with only the minimum due each month, the way card agreements usually put it:
 * a percent of the new balance plus that month's interest and fees, or a floor, whichever is more.
 * Each month, in this order:
 *   1. interest = balance × APR ÷ 12, to the cent (monthlyInterest), and fees, a fixed monthly
 *      amount as in project, are added: the new balance is balance + interest + fees;
 *   2. the minimum is `percent` of the new balance, to the cent (half up), plus the interest and
 *      fees when `plusInterest` is set, and at least `floor`;
 *   3. the payment is the minimum, but never more than the new balance, so the last one is smaller.
 * No new purchases. percent is in thousandths of a percent (1% = 1000), like rate. Returns what
 * project returns plus `first` (the first minimum), or { error: "too-small", charge, payment }
 * when a minimum doesn't cover that month's interest and fees, so the balance never falls, or
 * { error: "too-long" } after 100 years.
 */
export function projectMinimum({ balance, rate, percent, floor = 0, plusInterest = true, fees = 0 }) {
  const schedule = [];
  let owed = balance;
  let totalInterest = 0;
  let totalFees = 0;
  let totalPaid = 0;
  while (owed > 0) {
    if (schedule.length >= MAX_MONTHS) return { error: "too-long" };
    const charge = monthlyInterest(owed, rate);
    const statement = owed + charge + fees;
    let minimum = Number((BigInt(statement) * BigInt(percent) + 50000n) / 100000n);
    if (plusInterest) minimum += charge + fees;
    const paid = Math.min(Math.max(minimum, floor), statement);
    if (paid <= charge + fees) return { error: "too-small", charge: charge + fees, payment: paid };
    owed = statement - paid;
    schedule.push({ payment: paid, interest: charge, fees, principal: paid - charge - fees, balance: owed });
    totalInterest += charge;
    totalFees += fees;
    totalPaid += paid;
  }
  return { months: schedule.length, totalInterest, totalFees, totalPaid, schedule, first: schedule[0]?.payment ?? 0 };
}

// ---------- Reading and writing amounts ----------

/** "$9,000.50" → 900050 cents; NaN when it isn't an amount. */
export function parseMoney(text) {
  const s = String(text ?? "").replace(/[\s$,]/g, "");
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(s)) return NaN;
  const [whole, fraction = ""] = s.split(".");
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  return cents <= MAX_CENTS ? cents : NaN;
}

/** "4.9%" → 4900 (thousandths of a percent); NaN when it isn't a rate from 0 to 1,000%. */
export function parseRate(text) {
  const s = String(text ?? "").replace(/[\s%]/g, "");
  if (!/^(\d+(\.\d{0,3})?|\.\d{1,3})$/.test(s)) return NaN;
  const [whole, fraction = ""] = s.split(".");
  const rate = Number(whole || "0") * 1000 + Number(fraction.padEnd(3, "0"));
  return rate <= MAX_RATE ? rate : NaN;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2026-11", "11/2026" or "November 2026" → a month number (year × 12 + month − 1); NaN otherwise. */
export function parseMonth(text) {
  const s = String(text ?? "").trim();
  let year;
  let month;
  let m;
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(s))) [year, month] = [Number(m[1]), Number(m[2])];
  else if ((m = /^(\d{1,2})\/(\d{4})$/.exec(s))) [year, month] = [Number(m[2]), Number(m[1])];
  else if ((m = /^([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i.exec(s)))
    [year, month] = [Number(m[2]), MONTHS.indexOf(m[1].toLowerCase()) + 1];
  if (!year || !(month >= 1 && month <= 12)) return NaN;
  return year * 12 + month - 1;
}

/** A month number → "2026-11", the value a month input takes. */
export function monthValue(index) {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** A month number → "November 2026" (or "Nov 2026" with short). */
export function monthName(index, short = false) {
  const date = new Date(Date.UTC(Math.floor(index / 12), index % 12, 1));
  return date.toLocaleDateString("en-US", { month: short ? "short" : "long", year: "numeric", timeZone: "UTC" });
}

/** 3917 → "$39.17". With short, whole dollars drop the cents: 75000 → "$750". */
export function money(cents, short = false) {
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = abs % 100;
  return `${cents < 0 ? "-" : ""}$${dollars}${short && rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 13 → "1 year 1 month"; 7 → "7 months". */
export function duration(months) {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (!years) return plural(rest, "month");
  return rest ? `${plural(years, "year")} ${plural(rest, "month")}` : plural(years, "year");
}

// ---------- Results ----------

function stats(run, start) {
  const span = run.months >= 12 ? ` <span>(${duration(run.months)})</span>` : "";
  return `<dl class="calc-stats">
  <div><dt>Months to payoff</dt><dd>${run.months}${span}</dd></div>
  <div><dt>Payoff month</dt><dd>${monthName(start + run.months - 1)}</dd></div>
  <div><dt>Total interest</dt><dd>${money(run.totalInterest)}</dd></div>
  <div><dt>Total paid</dt><dd>${money(run.totalPaid)}</dd></div>
</dl>`;
}

function problem(run, monthly) {
  if (run.error === "too-long") {
    return `<p class="calc-problem">At ${money(monthly)} a month, this takes more than 100 years to pay off. Try a larger payment.</p>`;
  }
  return `<p class="calc-problem">This never gets paid off. The first month's interest is ${money(run.charge)}, so ${money(monthly)} a month doesn't bring the balance down. Pay more than ${money(run.charge)} a month.</p>`;
}

function card(title, run, start, monthly, extra = false) {
  return `<section class="calc-card${extra ? " is-extra" : ""}">
<h3>${title}</h3>
${run.error ? problem(run, monthly) : stats(run, start)}
</section>`;
}

function saving(base, boosted, extra, what = `The extra ${money(extra, true)} a month`, several = false) {
  // "The extra $50 a month pays…", but "The extra $50 a month and the lump sum pay…".
  const [pays, doesnt, gets] = several ? ["pay", "don't", "are what get"] : ["pays", "doesn't", "is what gets"];
  if (boosted.error) return "";
  if (base.error) return `<p class="calc-saving">${what} ${gets} it paid off.</p>`;
  const months = base.months - boosted.months;
  const interest = base.totalInterest - boosted.totalInterest;
  if (!months && !interest) return `<p class="calc-saving">${what} ${doesnt} change the payoff month or the interest.</p>`;
  if (!interest) return `<p class="calc-saving">${what} ${pays} it off <b>${duration(months)} sooner</b>. At 0% there's no interest to save.</p>`;
  if (!months) return `<p class="calc-saving">${what} ${doesnt} change the payoff month, but ${several ? "they save" : "it saves"} <b>${money(interest)}</b> in interest.</p>`;
  return `<p class="calc-saving">${what} ${pays} it off <b>${duration(months)} sooner</b> and ${several ? "save" : "saves"} <b>${money(interest)}</b> in interest.</p>`;
}

function minimumCard(run, start) {
  const body = run.error === "too-long"
    ? `<p class="calc-problem">Paying only the minimum takes more than 100 years.</p>`
    : run.error
      ? `<p class="calc-problem">Paying only the minimum never pays this off: the first minimum, ${money(run.payment)}, doesn't cover the month's interest and fees of ${money(run.charge)}.</p>`
      : stats(run, start);
  const first = run.error ? "" : ` <span>(first minimum ${money(run.first)})</span>`;
  return `<div class="calc-cards is-single">
<section class="calc-card is-minimum">
<h3>Paying only the minimum${first}</h3>
${body}
</section>
</div>`;
}

function versusMinimum(least, base, payment) {
  if (least.error || base.error) return "";
  const months = least.months - base.months;
  const interest = least.totalInterest - base.totalInterest;
  if (months <= 0 && interest <= 0) return "";
  return `<p class="calc-saving">Paying ${money(payment, true)} a month instead of only the minimum pays it off <b>${duration(Math.max(months, 0))} sooner</b> and saves <b>${money(Math.max(interest, 0))}</b> in interest.</p>`;
}

/**
 * The runs for a set of inputs (amounts in cents, rate in thousandths of a percent, start a month
 * number): what the results region shows, the schedule to list, and its caption. `lumps` are
 * one-time payments as in project. With `minimum` ({ percent, floor, plusInterest }), paying only
 * the minimum is shown first, for comparison.
 */
export function calculate({ balance, rate, payment, extra = 0, lumps = [] }, start, note = "", minimum = null) {
  const base = project({ balance, rate, payment });
  const boosted = extra > 0 || lumps.length ? project({ balance, rate, payment, extra, lumps }) : null;
  const least = minimum ? projectMinimum({ balance, rate, ...minimum }) : null;
  const intro = note ? `<p class="calc-note">${note}</p>
` : "";
  const title = `Paying ${money(payment, true)} a month`;
  const lead = least ? `${minimumCard(least, start)}
${versusMinimum(least, base, payment)}
` : "";
  const lump = lumps[0];
  const lumpText = lump ? `a ${money(lump.amount, true)} lump sum in ${monthName(start + lump.month)}` : "";
  let plan;
  let what;
  if (!lump) {
    plan = `With ${money(extra, true)} extra: ${money(payment + extra, true)} a month`;
  } else if (extra > 0) {
    plan = `With ${money(extra, true)} extra a month and ${lumpText}`;
    what = `The extra ${money(extra, true)} a month and the lump sum`;
  } else {
    plan = `With ${lumpText}`;
    what = `The ${money(lump.amount, true)} lump sum`;
  }
  // A lump sum that falls after the payoff month is never paid.
  const unused = lump && boosted && !boosted.error && lump.month >= boosted.months
    ? `<p class="calc-note">It's paid off before ${monthName(start + lump.month)}, so the lump sum isn't needed.</p>
`
    : "";
  let html;
  if (!boosted) {
    html = `${intro}${lead}<div class="calc-cards is-single">
${card(title, base, start, payment)}
</div>`;
  } else {
    html = `${intro}${lead}<div class="calc-cards">
${card(title, base, start, payment)}
${card(plan, boosted, start, payment + extra, true)}
</div>
${unused}${saving(base, boosted, extra, what, Boolean(lump) && extra > 0)}`;
  }
  const listed = boosted && !boosted.error ? boosted : base.error ? null : base;
  const caption = listed
    ? `Payment schedule${listed === boosted ? (lump ? " with your extra payments" : " with the extra payment") : ""} (${plural(listed.months, "payment")})`
    : "";
  return {
    html,
    schedule: listed ? scheduleHtml(listed, start) : "",
    csv: listed ? scheduleCsv(listed, start) : "",
    caption,
  };
}

/** The same schedule as a CSV file: month, payment, interest, fees (when there are any), principal, balance. */
export function scheduleCsv(run, start) {
  const plain = (cents) => (cents < 0 ? "-" : "") + `${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
  const withFees = run.totalFees > 0;
  const head = ["Month", "Payment", "Interest", ...(withFees ? ["Fees"] : []), "Principal", "Balance"];
  const rows = run.schedule.map((r, i) =>
    [monthValue(start + i), plain(r.payment), plain(r.interest), ...(withFees ? [plain(r.fees)] : []), plain(r.principal), plain(r.balance)].join(","),
  );
  return [head.join(","), ...rows].join("\r\n") + "\r\n";
}

/** The month-by-month table for one run. */
export function scheduleHtml(run, start) {
  const rows = run.schedule
    .map(
      (r, i) =>
        `<tr><th scope="row">${monthName(start + i, true)}</th><td>${money(r.payment)}</td><td>${money(r.interest)}</td><td>${money(r.principal)}</td><td>${money(r.balance)}</td></tr>`,
    )
    .join("\n");
  const principal = run.schedule.reduce((sum, r) => sum + r.principal, 0);
  return `<table class="calc-table">
<thead><tr><th scope="col">Month</th><th scope="col">Payment</th><th scope="col">Interest</th><th scope="col">Principal</th><th scope="col">Balance</th></tr></thead>
<tbody>
${rows}
</tbody>
<tfoot><tr><th scope="row">Total</th><td>${money(run.totalPaid)}</td><td>${money(run.totalInterest)}</td><td>${money(principal)}</td><td></td></tr></tfoot>
</table>`;
}

// ---------- The page ----------

function init() {
  const form = document.getElementById("payoff-form");
  const results = document.getElementById("payoff-results");
  const details = document.getElementById("payoff-schedule");
  if (!form || !results) return;
  const field = (id) => document.getElementById(id);
  const summary = details?.querySelector("summary");
  const body = details?.querySelector("[data-schedule]");

  // The first payment defaults to next month and the payoff month to three years of payments,
  // unless the browser kept what was typed before.
  const now = new Date();
  const next = now.getFullYear() * 12 + now.getMonth() + 1;
  const start = field("start");
  const target = field("target");
  if (start && start.value === start.defaultValue) start.value = monthValue(next);
  if (target && target.value === target.defaultValue) target.value = monthValue(next + 35);
  const lumpMonth = field("lump-month");
  if (lumpMonth && lumpMonth.value === lumpMonth.defaultValue) lumpMonth.value = monthValue(next + 5);
  // The buttons stay disabled in the HTML, so the form can't be sent anywhere without this script.
  for (const button of form.querySelectorAll("button")) button.disabled = false;

  const checks = {
    balance: [parseMoney, "Enter the balance you owe, like 9000 or 9,000.50."],
    rate: [parseRate, "Enter the interest rate as a percent from 0 to 1,000, like 4.9."],
    payment: [parseMoney, "Enter the monthly payment, like 750."],
    extra: [(s) => (s.trim() ? parseMoney(s) : 0), "Enter the extra payment as an amount, like 150, or leave it empty."],
    start: [parseMonth, "Enter the month of the first payment, like 2026-11."],
    target: [parseMonth, "Enter the month you want it paid off, like 2028-06."],
    "min-percent": [(s) => (parseRate(s) <= 100000 ? parseRate(s) : NaN), "Enter the minimum as a percent of the balance from 0 to 100, like 1."],
    "min-floor": [(s) => (s.trim() ? parseMoney(s) : 0), "Enter the lowest minimum your card asks for, like 40, or leave it empty."],
    "lump-amount": [(s) => (s.trim() ? parseMoney(s) : 0), "Enter the one-time payment as an amount, like 2000, or leave it empty."],
    "lump-month": [parseMonth, "Enter the month of the one-time payment, like 2027-04."],
  };
  /** Reads the named fields; returns { values } or { error } and marks the field that's wrong. */
  const read = (names) => {
    const values = {};
    for (const input of form.querySelectorAll("input")) input.removeAttribute("aria-invalid");
    for (const name of names) {
      const input = field(name);
      const [parse, message] = checks[name];
      const value = parse(input.value);
      let error = Number.isNaN(value) ? message : "";
      if (!error && name === "balance" && value === 0) error = "Enter a balance above $0.";
      if (!error && name === "payment" && value === 0) error = "Enter a monthly payment above $0.";
      if (error) {
        input.setAttribute("aria-invalid", "true");
        return { error, input };
      }
      values[name] = value;
    }
    return { values };
  };
  const fail = (error) => {
    results.innerHTML = `<p class="calc-problem">${error}</p>`;
    if (details) details.hidden = true;
  };
  const hasMinimum = Boolean(field("min-percent"));
  const hasLump = Boolean(field("lump-amount"));
  let csv = "";
  const show = (note = "") => {
    const names = ["balance", "rate", "payment", "extra", "start", ...(hasMinimum ? ["min-percent", "min-floor"] : []), ...(hasLump ? ["lump-amount"] : [])];
    const { values, error } = read(names);
    if (error) return fail(error);
    values.lumps = [];
    if (hasLump && values["lump-amount"] > 0) {
      const when = parseMonth(field("lump-month").value);
      if (Number.isNaN(when) || when < values.start) {
        field("lump-month").setAttribute("aria-invalid", "true");
        return fail(Number.isNaN(when) ? checks["lump-month"][1] : "The one-time payment has to be in the month of the first payment or later.");
      }
      values.lumps = [{ month: when - values.start, amount: values["lump-amount"] }];
    }
    const minimum = hasMinimum
      ? { percent: values["min-percent"], floor: values["min-floor"], plusInterest: field("min-interest")?.checked ?? true }
      : null;
    const out = calculate(values, values.start, note, minimum);
    results.innerHTML = out.html;
    csv = out.csv;
    if (details && body && summary) {
      details.hidden = !out.schedule;
      body.innerHTML = out.schedule;
      summary.textContent = out.caption;
    }
  };

  // Download the listed schedule as a CSV file, or print it.
  if (details && body) {
    const actions = document.createElement("div");
    actions.className = "calc-schedule-actions";
    actions.innerHTML = `<button class="btn btn-sm" type="button" data-csv>Download CSV</button> <button class="btn btn-sm btn-ghost" type="button" data-print>Print</button>`;
    body.before(actions);
    actions.querySelector("[data-csv]").addEventListener("click", () => {
      const name = location.pathname.split("/").filter(Boolean).pop() || "payoff";
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name.replace(/-calculator$/, "")}-schedule.csv`;
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
  const find = () => {
    const { values, error } = read(["balance", "rate", "start", "target"]);
    if (error) return fail(error);
    const months = values.target - values.start + 1;
    if (months < 1) {
      field("target").setAttribute("aria-invalid", "true");
      return fail("The payoff month has to be the month of the first payment or later.");
    }
    const payment = paymentFor({ balance: values.balance, rate: values.rate, months });
    field("payment").value = (payment / 100).toFixed(2);
    show(
      `To pay it off by ${monthName(values.target)}, pay <b>${money(payment)}</b> a month (${plural(months, "payment")} at most). It's now filled in as the monthly payment.`,
    );
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    show();
  });
  form.addEventListener("change", (event) => {
    if (event.target.id !== "target") show();
  });
  form.querySelector("[data-find-payment]")?.addEventListener("click", find);
  show();
}

if (typeof document !== "undefined") init();
