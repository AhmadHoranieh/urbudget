import type { Split, Transaction } from "./types";

/** A report-only bucket: it never creates an envelope or changes money assignments. */
export const UNCATEGORIZED_CATEGORY = "__uncategorized";

/** Matches ledger::explicitly_unassigned, including legacy imports before normalization. */
export function leftUnassigned(t: Transaction & { source?: Record<string, unknown> }, s: Split): boolean {
  if (typeof s.unassigned === "boolean") return s.unassigned;
  const source = s.source ?? (t.splits.length === 1 ? t.source : undefined);
  return source?.category_name === "Inflow: Ready to Assign" || source?.category_name === "Inflow: To be Budgeted" ||
    t.payee === "Reconciliation adjustment";
}

/** Renaming, recategorizing or converting an imported opening entry restores normal reporting. */
export function isStartingBalance(t: Transaction): boolean {
  return t.startingBalance === true && t.payee === "Starting Balance" && !t.transferAccountId &&
    t.splits.length > 0 && t.splits.every((s) => s.categoryId === null && s.unassigned !== false && !s.transferAccountId);
}

/** Amount is signed from the budget side, including transfers stored in a tracking account. */
export function splitRole(t: Transaction, s: Split, budgetAmount: number): "income" | "expense" | "uncategorized" | "opening" {
  if (isStartingBalance(t)) return "opening";
  if (s.categoryId !== null) return "expense";
  return budgetAmount >= 0 || leftUnassigned(t, s) ? "income" : "uncategorized";
}

/** Split payees mean the same thing in native aggregation and the rows behind a figure. */
export const effectivePayee = (t: Transaction, s: Split): string => s.payee || t.payee;
