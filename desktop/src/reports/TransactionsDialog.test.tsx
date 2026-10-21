import { expect, it } from "vitest";
import { demoBudget } from "../demo";
import type { Budget, Transaction } from "../types";
import { reportLines } from "./TransactionsDialog";

const tx = (t: Partial<Transaction> & Pick<Transaction, "id" | "date" | "accountId" | "amount">): Transaction => ({
  payee: "",
  memo: "",
  status: "cleared",
  splits: [{ categoryId: null, amount: t.amount }],
  transferAccountId: null,
  transferStatus: null,
  ...t,
});

function budget(): Budget {
  const b = demoBudget();
  b.accounts.push({ id: "invest", name: "Brokerage", kind: "tracking", openingBalance: 0, archived: false });
  b.transactions = [
    tx({ id: "a", date: "2026-10-03", accountId: "checking", payee: "Lulu", amount: -3000, splits: [{ categoryId: "groceries", amount: -3000 }] }),
    tx({ id: "b", date: "2026-10-09", accountId: "credit", payee: "Lulu", amount: -1000, splits: [{ categoryId: "groceries", amount: -1000 }] }),
    // A refund at the same payee counts against its spending.
    tx({ id: "c", date: "2026-10-12", accountId: "checking", payee: "Lulu", amount: 500, splits: [{ categoryId: "groceries", amount: 500 }] }),
    // Outside the dates.
    tx({ id: "d", date: "2026-09-30", accountId: "checking", payee: "Lulu", amount: -700, splits: [{ categoryId: "groceries", amount: -700 }] }),
    // Income to Ready to Assign.
    tx({ id: "e", date: "2026-10-01", accountId: "checking", payee: "Employer", amount: 900000 }),
    // A card payment between two budget accounts never shows.
    tx({ id: "f", date: "2026-10-05", accountId: "checking", payee: "", amount: -2000, transferAccountId: "credit", splits: [{ categoryId: null, amount: -2000 }] }),
    // A categorized move to a tracking account is spending, signed from the budget side.
    tx({ id: "g", date: "2026-10-06", accountId: "invest", payee: "", amount: 4000, transferAccountId: "checking", splits: [{ categoryId: "groceries", amount: 4000 }] }),
  ];
  return b;
}
const october = { from: "2026-10-01", to: "2026-10-31" };

it("lists a payee's spending in the range, refunds included", () => {
  const lines = reportLines(budget(), { ...october, payee: "Lulu" });
  expect(lines.map((l) => [l.date, l.amount, l.category])).toEqual([
    ["2026-10-12", 500, "Groceries"],
    ["2026-10-09", -1000, "Groceries"],
    ["2026-10-03", -3000, "Groceries"],
  ]);
});

it("narrows to accounts and categories, and lists income apart from spending", () => {
  const b = budget();
  expect(reportLines(b, { ...october, payee: "Lulu", accountIds: new Set(["credit"]) }).map((l) => l.amount)).toEqual([-1000]);
  expect(reportLines(b, { ...october, categoryIds: new Set(["rent"]) })).toEqual([]);
  expect(reportLines(b, { ...october, payee: "Employer", income: true }).map((l) => l.amount)).toEqual([900000]);
  expect(reportLines(b, { ...october, payee: "Employer" })).toEqual([]);
});

it("counts moves to tracking accounts from the budget side and skips moves between budget accounts", () => {
  const lines = reportLines(budget(), { from: "2026-10-05", to: "2026-10-06" });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ amount: -4000, account: "Everyday account", payee: "Transfer: Brokerage" });
});
