import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFormat } from "../format";
import type { Budget, Transaction } from "../types";
import type { ReportData, Scope } from "./shared";
import { UNCATEGORIZED_CATEGORY } from "../accounting";
import { ByCategory, ByPayee } from "./Spending";
import { CashFlow, IncomeBreakdown, IncomeExpense } from "./Income";
import { reportLines, reportTransactionIds, TransactionsDialog } from "./TransactionsDialog";

const budget = (): Budget => ({ schemaVersion: 2, name: "Test", currency: "USD", assignments: [],
  accounts: [{ id: "cash", name: "Cash", kind: "cash", archived: false, openingBalance: 100000 },
    { id: "card", name: "Card", kind: "credit", archived: false, openingBalance: 0 },
    { id: "tracking", name: "Brokerage", kind: "tracking", archived: false, openingBalance: 0 }],
  categories: [{ id: "food", name: "Food", group: "Living", target: 0 },
    { id: "clothing", name: "Clothing", group: "Living", target: 0 },
    { id: "payment", name: "Card payment", group: "Cards", target: 0, paymentAccountId: "card" }], transactions: [] });
const tx = (extra: Partial<Transaction> = {}): Transaction => ({ id: "parent", date: "2026-10-10", accountId: "cash",
  payee: "Combined", memo: "", amount: -10000, status: "cleared", transferAccountId: null, transferStatus: null,
  splits: [{ categoryId: "food", amount: -10000 }], ...extra });
const october = { from: "2026-10-01", to: "2026-10-31" };
function scope(extra: Partial<ReportData> = {}): Scope {
  const categories = { food: 10000, clothing: -3000 };
  const data: ReportData = { months: [{ month: "2026-10", income: 10000, spending: 7000, netIncome: 3000,
    assets: 100000, debt: 0, netWorth: 100000, categories, incomeSources: { Employer: 10000 }, accounts: {}, inflow: 13000, outflow: 10000 }],
    categories, incomeSources: { Employer: 10000 }, payees: { Shop: { amount: 10000, count: 2 }, RefundStore: { amount: -3000, count: 1 } },
    transactionCount: 2, income: 10000, spending: 7000, ageOfMoney: null, ageOfMoneyByMonth: {}, ...extra };
  return { data, budget: budget(), from: "2026-10", to: "2026-10", accounts: new Set(), someCategories: false,
    groupOf: new Map([["food", "Living"], ["clothing", "Living"], [UNCATEGORIZED_CATEGORY, "Needs a category"]]),
    nameOf: new Map([["food", "Food"], ["clothing", "Clothing"], [UNCATEGORIZED_CATEGORY, "Needs a category"]]),
    spendingGroups: ["Living", "Needs a category"], colorOf: () => "var(--series-1)", inspect: vi.fn(), show: vi.fn() };
}
const tile = (label: string) => [...document.querySelectorAll(".report-tiles > div")]
  .find((node) => node.querySelector("dt")?.textContent === label)?.querySelector("dd")?.textContent;
beforeEach(() => { configureFormat({ currency: "USD" }); localStorage.clear(); });
afterEach(cleanup);

it("keeps signed payee refunds in totals, search and drilldowns, with a separate positive treemap", () => {
  const s = scope();
  render(<ByPayee scope={s} />);
  expect(tile("Spending")).toBe("$70.00");
  expect(tile("Average per transaction")).toBe("$35.00");
  const table = screen.getByRole("table", { name: "Payee spending" });
  const refund = within(table).getByRole("button", { name: "RefundStore" });
  expect(refund.closest("tr")?.textContent).toContain("-$30.00");
  expect(refund.closest("tr")?.textContent).toContain("-42.9%");
  fireEvent.click(refund);
  expect(s.show).toHaveBeenCalledWith({ title: "RefundStore", payee: "RefundStore" });
  fireEvent.change(screen.getByRole("textbox", { name: "Find a payee" }), { target: { value: "RefundStore" } });
  expect(within(screen.getByRole("table", { name: "Payee spending" })).queryByRole("button", { name: "Shop" })).toBeNull();
  expect(screen.getByText(/Net refunds of \$30.00 at other payees reduce the total/)).toBeTruthy();
});

it("shows negative-only payee totals and retains fully offset payees", () => {
  render(<ByPayee scope={scope({ spending: -3000, transactionCount: 3,
    payees: { RefundStore: { amount: -3000, count: 1 }, Offset: { amount: 0, count: 2 } } })} />);
  expect(tile("Spending")).toBe("-$30.00");
  expect(tile("Average per transaction")).toBe("-$10.00");
  const table = screen.getByRole("table", { name: "Payee spending" });
  expect(within(table).getByRole("button", { name: "RefundStore" })).toBeTruthy();
  expect(within(table).getByRole("button", { name: "Offset" })).toBeTruthy();
  expect(screen.getByText("No payees with net spending in these months.")).toBeTruthy();
});

it("keeps refunded-to-zero payees and their transaction counts without a spurious percentage", () => {
  render(<ByPayee scope={scope({ spending: 0, transactionCount: 2, payees: { Offset: { amount: 0, count: 2 } } })} />);
  expect(tile("Spending")).toBe("$0.00");
  expect(tile("Average per transaction")).toBe("$0.00");
  const row = screen.getByRole("button", { name: "Offset" }).closest("tr")!;
  expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Offset", "$0.00", "—", "2", "$0.00"]);
});

it("retains missing-category spending in category totals and gives it a drilldown", () => {
  const s = scope({ categories: { food: 10000, clothing: -3000, [UNCATEGORIZED_CATEGORY]: 2000 }, spending: 9000 });
  render(<ByCategory scope={s} />);
  expect(tile("Spending")).toBe("$90.00");
  const groups = screen.getByRole("list", { name: "Spending by group" });
  fireEvent.click(within(groups).getByRole("button", { name: /^Needs a category/ }));
  const ring = screen.getByRole("group", { name: "Spending in Needs a category by category" });
  fireEvent.click(within(ring).getByRole("button", { name: /^Needs a category:/ }));
  expect(s.show).toHaveBeenLastCalledWith({ title: "Needs a category", categoryId: UNCATEGORIZED_CATEGORY });
  const categories = screen.getByRole("list", { name: "Spending in Needs a category" });
  fireEvent.click(within(categories).getByRole("button", { name: /^Needs a category/ }));
  expect(s.show).toHaveBeenCalledWith({ title: "Needs a category", categoryId: UNCATEGORIZED_CATEGORY });
  expect(s.budget.categories.some((category) => category.id === UNCATEGORIZED_CATEGORY)).toBe(false);
});

it("shows filtered income/expense reports without hiding income or calling budget surplus wealth saved", () => {
  const s = scope(); s.someCategories = true;
  render(<IncomeExpense scope={s} />);
  expect(tile("Income")).toBe("$100.00");
  expect(tile("Spending")).toBe("$70.00");
  expect(tile("Budget surplus")).toBe("$30.00");
  expect(tile("Budget surplus rate")).toBe("30.0%");
  expect(tile("Positive-surplus months")).toBe("1 of 1");
  expect(screen.getByRole("heading", { name: "Cumulative budget surplus" })).toBeTruthy();
  expect(screen.getByText(/Income stays included; spending reflects the chosen categories/)).toBeTruthy();
  expect(screen.queryByText("Savings rate")).toBeNull();
  expect(screen.queryByText(/Clear the Categories filter/)).toBeNull();
});

it("retains income breakdown under category scope and explains signed income separately from its positive chart", () => {
  const s = scope({ income: 7500, incomeSources: { Employer: 10000, Adjustment: -2500 } }); s.someCategories = true;
  render(<IncomeBreakdown scope={s} />);
  expect(tile("Income")).toBe("$75.00");
  expect(screen.getByRole("button", { name: "Adjustment" })).toBeTruthy();
  expect(screen.getByText(/income total and source table include amounts taken out/)).toBeTruthy();
  expect(screen.queryByText(/Clear the Categories filter/)).toBeNull();
});

it("describes cash flow as account-boundary movement including credit purchases, not gross split amounts", () => {
  render(<CashFlow scope={scope()} />);
  expect(tile("Money in")).toBe("$130.00");
  expect(tile("Money out")).toBe("$100.00");
  expect(screen.getByText(/including credit-card purchases and transfers to tracking accounts/)).toBeTruthy();
  expect(screen.getByText(/Split inflows and outflows may be netted/)).toBeTruthy();
  expect(screen.queryByText(/before netting/)).toBeNull();
});

it.each([false, true])("honors each split payee in report and register drilldowns (transfer=%s)", (transfer) => {
  const b = budget(); b.transactions = [tx({ amount: -15000, splits: [
    { categoryId: "food", amount: -10000, payee: "Grocer" },
    { categoryId: "clothing", amount: -5000, payee: "Broker", ...(transfer ? { transferAccountId: "tracking" } : {}) },
  ] })];
  expect(reportLines(b, { ...october, payee: "Grocer" })).toEqual([expect.objectContaining({ amount: -10000, payee: "Grocer" })]);
  expect(reportLines(b, { ...october, payee: "Broker" }).map((line) => line.amount)).toEqual([-5000]);
  expect(reportLines(b, { ...october, payee: "Combined" })).toEqual([]);
  expect(reportTransactionIds(b, { ...october, payee: "Grocer" })).toEqual(new Set(["parent"]));
});

it("counts a split purchase once in the dialog and uses the parent count for its average", () => {
  const b = budget(); b.transactions = [tx({ splits: [
    { categoryId: "food", amount: -6000 }, { categoryId: "clothing", amount: -4000 },
  ] })];
  render(<TransactionsDialog budget={b} title="Combined" query={{ ...october, payee: "Combined" }} onClose={vi.fn()} onOpenRegister={vi.fn()} />);
  expect(screen.getByText("Transactions").parentElement?.querySelector("dd")?.textContent).toBe("1");
  expect(screen.getByText("Average").parentElement?.querySelector("dd")?.textContent).toBe("$100.00");
  expect(reportLines(b, october)).toHaveLength(2);
});

it("ignores zero expense parts but retains a net-zero parent with nonzero spending and refund parts", () => {
  const b = budget(); b.transactions = [
    tx({ id: "zero", amount: 0, splits: [{ categoryId: "food", amount: 0 }] }),
    tx({ id: "purchase", amount: -1000, splits: [
      { categoryId: "food", amount: -1000 }, { categoryId: "clothing", amount: 0, payee: "Empty" },
    ] }),
    tx({ id: "offset", amount: 0, splits: [
      { categoryId: "food", amount: -500 }, { categoryId: "clothing", amount: 500 },
    ] }),
  ];
  expect(reportLines(b, october)).toHaveLength(3);
  expect(reportLines(b, { ...october, payee: "Empty" })).toEqual([]);
  expect(reportTransactionIds(b, october)).toEqual(new Set(["purchase", "offset"]));
  render(<TransactionsDialog budget={b} title="Combined" query={october} onClose={vi.fn()} onOpenRegister={vi.fn()} />);
  expect(screen.getByText("Transactions").parentElement?.querySelector("dd")?.textContent).toBe("2");
  expect(screen.getByText("Average").parentElement?.querySelector("dd")?.textContent).toBe("$5.00");
});

it("separates missing-category outflows from signed explicit Unassigned income and excludes imported starting balances", () => {
  const b = budget(); b.transactions = [
    tx({ id: "salary", amount: 10000, payee: "Employer", splits: [{ categoryId: null, amount: 10000 }] }),
    tx({ id: "missing", amount: -1000, payee: "Shop", splits: [{ categoryId: null, amount: -1000 }] }),
    tx({ id: "explicit", amount: -500, payee: "Adjustment", splits: [{ categoryId: null, amount: -500, unassigned: true }] }),
    tx({ id: "opening", amount: 100000, payee: "Starting Balance", startingBalance: true, splits: [{ categoryId: null, amount: 100000 }] }),
  ];
  expect(reportLines(b, { ...october, income: true }).map((line) => line.amount).sort((a, b) => a - b)).toEqual([-500, 10000]);
  expect(reportLines(b, { ...october, categoryIds: new Set([UNCATEGORIZED_CATEGORY]) })).toEqual([
    expect.objectContaining({ amount: -1000, payee: "Shop", category: "Needs a category" }),
  ]);
  expect(reportTransactionIds(b, { ...october, income: true, categoryIds: new Set(["food"]) })).toEqual(new Set(["salary", "explicit"]));
  expect(reportTransactionIds(b, october)).toEqual(new Set(["missing"]));
});

it("restores normal classification when an imported opening entry is renamed or categorized", () => {
  const b = budget(); const opening = tx({ payee: "Starting Balance", amount: 1000, startingBalance: true,
    splits: [{ categoryId: null, amount: 1000 }] });
  b.transactions = [{ ...opening, id: "renamed", payee: "Employer" },
    { ...opening, id: "refund", splits: [{ categoryId: "food", amount: 1000 }] },
    { ...opening, id: "typed-name", startingBalance: undefined }];
  expect(reportTransactionIds(b, { ...october, income: true })).toEqual(new Set(["renamed", "typed-name"]));
  expect(reportLines(b, october)).toEqual([expect.objectContaining({ amount: 1000, category: "Food" })]);
});

it("classifies missing-category cross-boundary transfers from the budget side and respects account/category filters", () => {
  const b = budget(); b.transactions = [tx({ id: "reverse", accountId: "tracking", transferAccountId: "cash", amount: 2500,
    splits: [{ categoryId: null, amount: 2500 }] }),
    tx({ id: "payment", transferAccountId: "card", amount: -5000, splits: [{ categoryId: null, amount: -5000 }] }),
    tx({ id: "tracking-only", accountId: "tracking", splits: [{ categoryId: "food", amount: -10000 }] }),
  ];
  expect(reportLines(b, { ...october, accountIds: new Set(["cash"]), categoryIds: new Set([UNCATEGORIZED_CATEGORY]) }))
    .toEqual([expect.objectContaining({ amount: -2500, account: "Cash", category: "Needs a category" })]);
  expect(reportLines(b, { ...october, income: true })).toEqual([]);
  expect(reportLines(b, { ...october, accountIds: new Set(["tracking"]) })).toEqual([]);
  expect(reportLines(b, { ...october, categoryIds: new Set(["food"]) })).toEqual([]);
});
