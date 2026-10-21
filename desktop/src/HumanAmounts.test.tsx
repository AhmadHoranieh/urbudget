import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountForm, CategoryForm, ReconcileForm, TransactionForm } from "./forms";
import { configureFormat, money } from "./format";
import { demoBudget } from "./demo";
import { parseMoney } from "./types";

beforeEach(() => {
  configureFormat({ currency: "EUR", numberFormat: { decimal: ",", group: "." } });
});
afterEach(() => { cleanup(); configureFormat({ currency: "SAR" }); });

it.each([{ text: "12,34", cents: 1234 }, { text: "1.234,56", cents: 123456 }])("reads $text in the full transaction form", async ({ text, cents }) => {
  const save = vi.fn();
  render(<TransactionForm budget={demoBudget()} close={() => {}} save={save} />);
  fireEvent.click(screen.getByRole("button", { name: /Inflow/ }));
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: text } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add transaction" })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ amount: cents }));
  // Machine/import parsing keeps its canonical decimal-dot contract.
  expect(parseMoney("1,234.56")).toBe(123456);
});

it("preserves unchanged localized split amounts when editing", async () => {
  const b = demoBudget();
  const transaction = { ...b.transactions[0], amount: -1234,
    splits: [{ categoryId: "rent", amount: -1000 }, { categoryId: "groceries", amount: -234 }] };
  const save = vi.fn();
  render(<TransactionForm budget={b} initial={transaction} close={() => {}} save={save} />);
  expect(screen.getByLabelText(`Amount (${b.currency})`)).toHaveProperty("value", "12,34");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update transaction" })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ amount: -1234, splits: transaction.splits.map(s => expect.objectContaining(s)) }));
});

it("works out a sum typed in the budget's decimal format", async () => {
  const save = vi.fn();
  render(<TransactionForm budget={demoBudget()} close={() => {}} save={save} />);
  fireEvent.click(screen.getByRole("button", { name: /Inflow/ }));
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "12,34 + 1" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add transaction" })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ amount: 1334 }));
});

it("reads localized opening balances, category targets and reconciliation balances", async () => {
  const b = demoBudget();
  const saveAccount = vi.fn();
  const accountView = render(<AccountForm initial={b.accounts[0]} close={() => {}} save={saveAccount} />);
  fireEvent.change(screen.getByLabelText("Opening balance"), { target: { value: "12,34" } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(saveAccount).toHaveBeenCalledWith(expect.objectContaining({ openingBalance: 1234 }));
  accountView.unmount();
  const saveCategory = vi.fn();
  const categoryView = render(<CategoryForm initial={b.categories[0]} groups={[]} close={() => {}} save={saveCategory} />);
  fireEvent.change(screen.getByLabelText("Target amount"), { target: { value: "12,34" } });
  fireEvent.submit(screen.getByLabelText("Target amount").closest("form")!);
  expect(saveCategory).toHaveBeenCalledWith(expect.objectContaining({ target: 1234 }));
  categoryView.unmount();
  const reconcile = vi.fn(async () => {});
  render(<ReconcileForm account={b.accounts[0]} cleared={1234} money={money} close={() => {}} save={reconcile} />);
  expect(screen.getByLabelText("Bank balance")).toHaveProperty("value", "12,34");
  await act(async () => fireEvent.submit(screen.getByLabelText("Bank balance").closest("form")!));
  expect(reconcile).toHaveBeenCalledWith(1234);
});
