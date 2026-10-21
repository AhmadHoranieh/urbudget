import { describe, expect, it } from "vitest";
import { effectivePayee, isStartingBalance, leftUnassigned, splitRole } from "./accounting";
import type { Transaction } from "./types";

const tx = (amount = -10000): Transaction => ({ id: "purchase", date: "2026-10-20", accountId: "checking",
  payee: "Shop", memo: "", amount, status: "cleared", transferAccountId: null, transferStatus: null,
  splits: [{ amount, categoryId: null }] });

describe("budget and report classification", () => {
  it("distinguishes missing spending from a deliberate adjustment, including reversed tracking transfers", () => {
    const t = tx();
    expect(splitRole(t, t.splits[0], -10000)).toBe("uncategorized");
    expect(splitRole(t, { ...t.splits[0], unassigned: true }, -10000)).toBe("income");
    // A tracking-side inflow is money leaving the budget: classify the budget-side amount.
    expect(splitRole(tx(10000), { amount: 10000, categoryId: null }, -10000)).toBe("uncategorized");
    expect(splitRole(t, { amount: 10000, categoryId: null }, 10000)).toBe("income");
  });

  it("keeps categorized refunds as expense offsets, not income", () => {
    const t = tx(3000);
    expect(splitRole(t, { amount: 3000, categoryId: "clothes" }, 3000)).toBe("expense");
  });

  it("uses normalized RTA intent after source data is hidden and honors an explicit clear", () => {
    const t = tx();
    expect(leftUnassigned(t, { ...t.splits[0], unassigned: true })).toBe(true);
    const imported = { ...t, source: { category_id: "rta", category_name: "Inflow: Ready to Assign" } };
    expect(leftUnassigned(imported, imported.splits[0])).toBe(true);
    expect(leftUnassigned(imported, { ...imported.splits[0], unassigned: false })).toBe(false);
    expect(leftUnassigned({ ...t, source: { category_id: "old-envelope" } }, t.splits[0])).toBe(false);
    const adjustment = { ...t, payee: "Reconciliation adjustment" };
    expect(leftUnassigned(adjustment, adjustment.splits[0])).toBe(true);
    expect(leftUnassigned(adjustment, { ...adjustment.splits[0], unassigned: false })).toBe(false);
  });

  it("excludes a verified opening entry until its payee or category role changes", () => {
    const t = { ...tx(100000), payee: "Starting Balance", startingBalance: true };
    expect(splitRole(t, t.splits[0], 100000)).toBe("opening");
    expect(isStartingBalance({ ...t, payee: "Salary" })).toBe(false);
    expect(isStartingBalance({ ...t, splits: [{ amount: 100000, categoryId: "food" }] })).toBe(false);
    expect(isStartingBalance({ ...t, transferAccountId: "savings" })).toBe(false);
    expect(isStartingBalance({ ...t, splits: [{ ...t.splits[0], transferAccountId: "savings" }] })).toBe(false);
    expect(isStartingBalance({ ...t, startingBalance: undefined })).toBe(false);
    expect(isStartingBalance({ ...t, splits: [{ ...t.splits[0], unassigned: false }] })).toBe(false);
  });

  it("uses a split's payee for ordinary and mixed-transfer splits", () => {
    const t = tx();
    expect(effectivePayee(t, { ...t.splits[0], payee: "Grocer" })).toBe("Grocer");
    expect(effectivePayee(t, { ...t.splits[0], payee: "" })).toBe("Shop");
  });
});
