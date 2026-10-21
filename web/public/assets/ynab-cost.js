// /ynab/price/: the "what YNAB costs over the years" calculator. Without this script the page
// still shows the totals after 1, 3, 5 and 10 years as a plain table. With it, a slider picks
// any number of years from 1 to 10, bars compare the four totals, and the table is redrawn
// from the same numbers (and from UrBudget's sync price in /api/v1/config).

import { getConfig } from "./api.js";

// YNAB's prices in US dollars, from ynab.com/pricing, checked October 17, 2026.
// When YNAB changes them, change them here and in the page's fallback table.
const YNAB = {
  yearly: 109,
  monthly: 14.99,
};

// UrBudget's sync price per month until /api/v1/config answers. The app itself is free.
const URBUDGET = {
  syncMonthly: 3,
};

const root = document.querySelector("[data-cost-calc]");
const years = document.getElementById("cost-years");
const yearsLabel = document.getElementById("cost-years-value");
const summary = document.querySelector("[data-cost-summary]");

/** A price label from the config ("$3", "$3.00") as dollars, or the fallback. */
function dollars(label, fallback) {
  const n = Number.parseFloat(String(label ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Whole cents, so sums like 12 × $14.99 come out exact. */
const cents = (amount) => Math.round(amount * 100);

/** "$1,090" for whole dollars, "$899.40" otherwise. */
function money(totalCents) {
  const whole = totalCents % 100 === 0;
  return (totalCents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

/** Each plan's total in cents after `n` years. */
function totals(n, prices) {
  return {
    ynabMonthly: cents(prices.ynabMonthly) * 12 * n,
    ynabYearly: cents(prices.ynabYearly) * n,
    urbudgetSync: cents(prices.syncMonthly) * 12 * n,
    urbudget: 0,
  };
}

function render(prices) {
  // The fallback table: every cell says which plan and how many years it holds.
  for (const cell of document.querySelectorAll("[data-cost][data-years]")) {
    const all = totals(Number(cell.dataset.years), prices);
    const value = all[cell.dataset.cost];
    if (value !== undefined) cell.textContent = money(value);
  }
  for (const slot of document.querySelectorAll("[data-ynab-price]")) {
    const kind = slot.dataset.ynabPrice;
    if (kind === "yearly") slot.textContent = money(cents(prices.ynabYearly));
    if (kind === "monthly") slot.textContent = money(cents(prices.ynabMonthly));
  }
  if (!root || !years) return;

  const n = Math.min(10, Math.max(1, Math.round(Number(years.value)) || 1));
  const all = totals(n, prices);
  const highest = Math.max(...Object.values(all)) || 1;
  const span = n === 1 ? "1 year" : `${n} years`;
  if (yearsLabel) yearsLabel.textContent = span;
  years.setAttribute("aria-valuetext", span);

  for (const [plan, value] of Object.entries(all)) {
    const total = root.querySelector(`[data-cost-total="${plan}"]`);
    const bar = root.querySelector(`[data-cost-bar="${plan}"]`);
    if (total) total.textContent = money(value);
    if (bar) bar.style.width = `${Math.max(1, (value / highest) * 100)}%`;
  }

  if (summary) {
    const savedWithSync = all.ynabYearly - all.urbudgetSync;
    let text =
      `Over ${span}, YNAB's yearly plan comes to ${money(all.ynabYearly)} and its monthly plan to ${money(all.ynabMonthly)}. ` +
      `UrBudget is free, or ${money(all.urbudgetSync)} with sync on the whole time`;
    text += savedWithSync > 0 ? `, ${money(savedWithSync)} less than YNAB's yearly plan.` : ".";
    summary.textContent = text;
  }
}

async function start() {
  const prices = {
    ynabYearly: YNAB.yearly,
    ynabMonthly: YNAB.monthly,
    syncMonthly: URBUDGET.syncMonthly,
  };
  if (root && years) {
    root.hidden = false;
    years.addEventListener("input", () => render(prices));
  }
  render(prices);

  // getConfig never rejects: without the API it resolves with the same $3.
  const config = await getConfig();
  prices.syncMonthly = dollars(config.prices?.sync, URBUDGET.syncMonthly);
  render(prices);
}

start();
