import { expect, it } from "vitest";
import { newBudget, type NewBudgetOptions } from "./newBudget";
import type { Budget, Summary } from "./types";

const options: NewBudgetOptions = {
  name: "Fresh start", currency: "USD", numberFormat: { decimal: ".", group: ",", symbol: "before" }, dateFormat: "iso", start: "copy",
};
const budget: Budget = {
  schemaVersion: 2, name: "Original", currency: "USD",
  accounts: [
    { id: "cash", name: "Checking", kind: "cash", openingBalance: 10000, archived: false,
      simplefin: { id: "bank-cash", from: "2026-09-01", lastSync: "2026-10-18" } },
    { id: "savings", name: "Savings", kind: "cash", openingBalance: 20000, archived: false },
  ],
  categories: [{ id: "food", name: "Food", group: "Everyday", target: 0 }], assignments: [],
  transactions: [
    { id: "split", date: "2026-10-18", accountId: "cash", payee: "Mixed", memo: "", amount: -500,
      status: "cleared", transferAccountId: null, transferStatus: null,
      splits: [{ categoryId: null, amount: -300, transferAccountId: "savings", transferStatus: "cleared" }, { categoryId: "food", amount: -200 }] },
    { id: "future", date: "2026-11-01", accountId: "cash", payee: "Paycheck", memo: "Planned", amount: 1000,
      status: "uncleared", transferAccountId: null, transferStatus: null, splits: [{ categoryId: null, amount: 1000 }] },
  ],
};
const summary: Summary = {
  readyToAssign: 0, assigned: 0, activity: 0, available: 0, income: 0, netWorth: 30800, categories: [],
  accounts: [{ id: "cash", balance: 10500, cleared: 9500, uncleared: 1000 }, { id: "savings", balance: 20300, cleared: 20300, uncleared: 0 }],
};

it("starts from today's balances, including split transfers, and keeps future entries separate", () => {
  const result = newBudget(options, { budget, summary }, "2026-10-19");
  expect(result.accounts.map(a => a.openingBalance)).toEqual([9500, 20300]);
  expect(result.transactions).toEqual([budget.transactions[1]]);
  expect(budget.transactions).toHaveLength(2);
});

it("disconnects copied bank links so the next overlap sync cannot replay capitalized history", () => {
  const result = newBudget(options, { budget, summary }, "2026-10-19");
  expect(result.accounts[0].simplefin).toBeUndefined();
  expect(budget.accounts[0].simplefin?.lastSync).toBe("2026-10-18");
});

it("refuses to relabel copied money as a different currency without conversion", () => {
  expect(() => newBudget({ ...options, currency: "EUR" }, { budget, summary })).toThrow(/same currency/i);
  expect(newBudget({ ...options, start: "blank", currency: "EUR" }, { budget, summary }).currency).toBe("EUR");
});

it("copies whole transfers into both opening balances without relying on a stale summary", () => {
  const b: Budget = { ...budget, transactions: [{ ...budget.transactions[0], amount: -2500, splits: [], transferAccountId: "savings", transferStatus: "cleared" }] };
  const result = newBudget(options, { budget: b, summary }, "2026-10-19");
  expect(result.accounts.map(a => a.openingBalance)).toEqual([7500, 22500]);
});

it.each(["source", "whole-transfer", "split-transfer", "unapproved"])("retains pending %s entries for clearing and bank matching", (side) => {
  const pending = { ...budget.transactions[0] };
  if (side === "source") pending.status = "uncleared";
  if (side === "unapproved") pending.approved = false;
  if (side === "whole-transfer") {
    pending.transferAccountId = "savings";
    pending.transferStatus = "uncleared";
    pending.splits = [];
  }
  if (side === "split-transfer") pending.splits = pending.splits.map(s => ({ ...s, transferStatus: "uncleared" }));
  const result = newBudget(options, { budget: { ...budget, transactions: [pending] }, summary }, "2026-10-19");
  expect(result.accounts.map(a => a.openingBalance)).toEqual([10000, 20000]);
  expect(result.transactions).toEqual([pending]);
});
