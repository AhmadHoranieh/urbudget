import type { Budget } from "./types";

export type PayeeInfo = {
  name: string;
  /** Transactions with this payee. */
  count: number;
  /** Date of the most recent one. */
  last: string;
  /** The payee's default category, or else that of its most recent single-category transaction; null means Ready to Assign. */
  categoryId?: string | null;
  /** `categoryId` is the payee's default, set on the Payees page. */
  fixed?: boolean;
};

/** Every payee with usage counts and the category it was last used with, most used first. */
export function payeeIndex(b: Pick<Budget, "transactions" | "payees"> & Partial<Pick<Budget, "categories">>): PayeeInfo[] {
  const index = new Map<string, PayeeInfo>();
  for (const t of b.transactions) {
    const name = t.payee.trim();
    if (!name || t.transferAccountId) continue;
    const info = index.get(name) ?? { name, count: 0, last: "" };
    info.count++;
    if (t.date >= info.last) {
      info.last = t.date;
      if (t.splits.length === 1 && !t.splits[0].transferAccountId)
        info.categoryId = t.splits[0].categoryId;
    }
    index.set(name, info);
  }
  const exists = b.categories && new Set(b.categories.map((c) => c.id));
  for (const p of b.payees ?? []) {
    // YNAB's own transfer payees ("Transfer : Savings") are offered as real transfers instead.
    const imported = p as { transfer_account_id?: string | null; deleted?: boolean };
    if (!p.name || imported.transfer_account_id || imported.deleted || p.name.startsWith("Transfer : ")) continue;
    const info = index.get(p.name) ?? { name: p.name, count: 0, last: "" };
    // A default category (skipped if that category has since been deleted) beats the last one used.
    if (p.categoryId && (p.categoryId === "__rta" || !exists || exists.has(p.categoryId))) {
      info.categoryId = p.categoryId === "__rta" ? null : p.categoryId;
      info.fixed = true;
    }
    index.set(p.name, info);
  }
  return [...index.values()].sort((a, c) => c.count - a.count || a.name.localeCompare(c.name));
}
