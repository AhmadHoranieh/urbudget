import { describe, expect, it } from "vitest";
import { uncategorizedCounts, uncategorizedTest } from "./uncategorized";
import type { Account, Budget, Split, Transaction } from "./types";

const account = (id: string, kind: Account["kind"] = "cash"): Account => ({ id, name: id, kind, openingBalance: 0, archived: false });
const budget = (transactions: Transaction[]): Budget => ({
  schemaVersion: 2,
  name: "Test",
  currency: "SAR",
  accounts: [account("checking"), account("savings"), account("card", "credit"), account("loan", "tracking")],
  categories: [
    { id: "food", name: "Food", group: "Everyday", target: 0 },
    { id: "ynab-none", name: "Uncategorized", group: "Internal", target: 0 },
  ],
  transactions,
  assignments: [],
});
const tx = (id: string, amount: number, splits: Partial<Split>[] = [{ categoryId: null }], more: Partial<Transaction> = {}): Transaction => ({
  id,
  date: "2026-10-15",
  accountId: "checking",
  payee: id,
  memo: "",
  amount,
  status: "cleared",
  splits: splits.map((s) => ({ categoryId: null, amount, ...s })),
  transferAccountId: null,
  transferStatus: null,
  ...more,
});
const NOW = "2026-10-20";

describe("spending that needs a category", () => {
  it("flags money leaving the budget with no category, and only that", () => {
    const needs = uncategorizedTest(budget([]), NOW);
    expect(needs(tx("lunch", -5000))).toBe(true);
    expect(needs(tx("on the card", -5000, [{ categoryId: null }], { accountId: "card" }))).toBe(true);
    // Income with no category is money for Unassigned.
    expect(needs(tx("salary", 500000))).toBe(false);
    expect(needs(tx("groceries", -5000, [{ categoryId: "food" }]))).toBe(false);
    // Not yet entered: scheduled.
    expect(needs(tx("later", -5000, [{ categoryId: null }], { date: "2026-11-01" }))).toBe(false);
    // YNAB's own Uncategorized category is no category.
    expect(needs(tx("imported", -5000, [{ categoryId: "ynab-none" }]))).toBe(true);
  });

  it("leaves spending taken from Unassigned on purpose alone", () => {
    const needs = uncategorizedTest(budget([]), NOW);
    expect(needs(tx("chosen here", -5000, [{ categoryId: null, unassigned: true }]))).toBe(false);
    // From YNAB: categorized to its Ready to Assign (the record names it), or left uncategorized there.
    expect(needs(tx("ynab rta", -5000, [{ categoryId: null, unassigned: true }]))).toBe(false);
    expect(needs({ ...tx("ynab none", -5000), source: { category_id: null } } as Transaction)).toBe(true);
  });

  it("asks only for transfers that move money out of the budget", () => {
    const needs = uncategorizedTest(budget([]), NOW);
    expect(needs(tx("to savings", -5000, [], { transferAccountId: "savings" }))).toBe(false);
    expect(needs(tx("loan payment", -5000, [{ categoryId: null }], { transferAccountId: "loan" }))).toBe(true);
    // The same payment recorded in the loan account: seen from the budget it's still money out.
    expect(needs(tx("loan payment, other side", 5000, [{ categoryId: null }], { accountId: "loan", transferAccountId: "checking" }))).toBe(true);
    expect(needs(tx("loan paid out", 5000, [{ categoryId: null }], { transferAccountId: "loan" }))).toBe(false);
  });

  it("tests one line of a split", () => {
    const needs = uncategorizedTest(budget([]), NOW);
    const t = tx("split", -8000, [
      { categoryId: "food", amount: -5000 },
      { categoryId: null, amount: -3000 },
    ]);
    expect(needs(t)).toBe(true);
    expect(needs(t, t.splits[0])).toBe(false);
    expect(needs(t, t.splits[1])).toBe(true);
  });

  it("counts them by the budget account they spend", () => {
    const b = budget([
      tx("a", -100),
      tx("b", -200),
      tx("c", -300, [{ categoryId: null }], { accountId: "card" }),
      tx("d", 300, [{ categoryId: null }], { accountId: "loan", transferAccountId: "checking" }),
      tx("e", -400, [{ categoryId: "food" }]),
    ]);
    const { total, amount, byAccount } = uncategorizedCounts(b, NOW);
    expect(total).toBe(4);
    expect(amount).toBe(900);
    expect(Object.fromEntries(byAccount)).toEqual({ checking: 3, card: 1 });
  });

  it("counts a tracking-side split once for every account with uncategorized spending", () => {
    const b = budget([tx("several payments", 1000, [
      { categoryId: "food", amount: 100, transferAccountId: "card" },
      { categoryId: null, amount: 200, transferAccountId: "checking" },
      { categoryId: null, amount: 300, transferAccountId: "checking" },
      { categoryId: null, amount: 400, transferAccountId: "savings" },
    ], { accountId: "loan" })]);
    const { total, amount, byAccount } = uncategorizedCounts(b, NOW);
    expect(total).toBe(1);
    expect(amount).toBe(900);
    expect(Object.fromEntries(byAccount)).toEqual({ checking: 1, savings: 1 });
  });
});
