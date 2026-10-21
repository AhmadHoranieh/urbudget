import { useMemo, type RefObject } from "react";
import { ArrowRight } from "lucide-react";
import { Popover } from "./ui";
import { money, monthName } from "./format";
import { TransactionLines, type ActivityLine } from "./TransactionLines";
import { newestFirst } from "./order";
import type { Account, Budget, Transaction } from "./types";

export type { ActivityLine };
export const onBudget = (a?: Account) => !!a && (a.onBudget ?? a.kind !== "tracking");

/**
 * The transactions behind a category's Activity for a month, counted the way the budget
 * engine counts them: categorized money in budget accounts, plus transfers between a budget
 * and a tracking account (signed from the budget side). Not for credit card payment
 * categories, whose activity is the card's spending and payments.
 */
export function categoryActivity(b: Budget, categoryId: string, month: string): ActivityLine[] {
  const accounts = new Map(b.accounts.map((a) => [a.id, a]));
  const name = (id: string | null | undefined) => accounts.get(id ?? "")?.name ?? "";
  const lines: { line: ActivityLine; t: Transaction }[] = [];
  for (const t of b.transactions) {
    if (!t.date.startsWith(month)) continue;
    const source = accounts.get(t.accountId);
    t.splits.forEach((s, i) => {
      if (s.categoryId !== categoryId) return;
      const other = s.transferAccountId ?? t.transferAccountId;
      let amount = s.amount,
        payee = s.payee || t.payee || "No payee",
        account = name(t.accountId);
      if (other) {
        // Only transfers that cross into or out of the budget carry a category.
        const fromBudget = onBudget(source);
        if (fromBudget === onBudget(accounts.get(other))) return;
        amount = fromBudget ? s.amount : -s.amount;
        payee = `Transfer: ${name(fromBudget ? other : t.accountId)}`;
        account = name(fromBudget ? t.accountId : other);
      } else if (!onBudget(source)) return;
      lines.push({ t, line: { key: `${t.id}:${i}`, date: t.date, payee, account, memo: s.memo || t.memo, amount } });
    });
  }
  // Newest first, like the register.
  return newestFirst(lines, (l) => l.t).map((l) => l.line);
}

export function ActivityPopover({
  budget,
  categoryId,
  categoryName,
  month,
  anchor,
  onClose,
  onOpenRegister,
}: {
  budget: Budget;
  categoryId: string;
  categoryName: string;
  month: string;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onOpenRegister: () => void;
}) {
  const lines = useMemo(() => categoryActivity(budget, categoryId, month), [budget.transactions, budget.accounts, categoryId, month]);
  const total = lines.reduce((n, l) => n + l.amount, 0);
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="bottom-end" label={`${categoryName} activity`} className="activity-popover">
      <div className="activity-head">
        <strong>{categoryName}</strong>
        <span className="muted">Activity in {monthName(month)}</span>
      </div>
      {lines.length ? (
        <TransactionLines lines={lines} label={`${categoryName} transactions`} />
      ) : (
        <p className="muted activity-empty">No transactions in this category this month.</p>
      )}
      <div className="activity-foot">
        <span>
          {lines.length} {lines.length === 1 ? "transaction" : "transactions"} · <strong>{money(total)}</strong>
        </span>
        <button className="link-button" data-autofocus onClick={onOpenRegister}>
          View in register <ArrowRight size={13} />
        </button>
      </div>
    </Popover>
  );
}
