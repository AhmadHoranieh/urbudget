import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TransactionEditor } from "./TransactionRow";
import { demoBudget } from "./demo";
import type { Transaction } from "./types";
import { setPref } from "./prefs";

afterEach(cleanup);

function editCategorizedTransaction() {
  const budget = demoBudget();
  const initial = {
    ...budget.transactions[0], accountId: "checking", amount: -2500,
    splits: [{ categoryId: "rent", amount: -2500 }],
  };
  const onSave = vi.fn(async (_transaction: Transaction) => {});
  const onCancel = vi.fn();
  render(<TransactionEditor budget={budget} accountId="checking" initial={initial}
    onSave={onSave} onCancel={onCancel} onMore={() => {}} />);
  const category = screen.getByRole("combobox", { name: "Category" });
  expect(category).toHaveProperty("value", "Rent");
  fireEvent.focus(category);
  fireEvent.change(category, { target: { value: "" } });
  return { category, onSave, onCancel };
}

it("commits a cleared category with Enter before the next Enter saves the transaction", async () => {
  const { category, onSave } = editCategorizedTransaction();
  fireEvent.keyDown(category, { key: "Enter" });
  expect(onSave).not.toHaveBeenCalled();
  expect(category).toHaveProperty("value", "");
  expect(screen.queryByRole("listbox", { name: "Category" })).toBeNull();
  fireEvent.keyDown(category, { key: "Enter" });
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0].splits).toEqual([expect.objectContaining({ categoryId: null, amount: -2500 })]);
});

it("saves a cleared category when clicking Save closes the dropdown before blur", async () => {
  const { category, onSave } = editCategorizedTransaction();
  const save = screen.getByRole("button", { name: "Save" });
  fireEvent.mouseDown(save);
  fireEvent.blur(category);
  fireEvent.mouseUp(save);
  fireEvent.click(save);
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0].splits).toEqual([expect.objectContaining({ categoryId: null, amount: -2500 })]);
});

it("keeps a category cleared after tabbing to another field", async () => {
  const { category, onSave } = editCategorizedTransaction();
  fireEvent.keyDown(category, { key: "Tab" });
  fireEvent.blur(category);
  expect(category).toHaveProperty("value", "");
  fireEvent.keyDown(screen.getByLabelText("Memo"), { key: "Enter" });
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0].splits).toEqual([expect.objectContaining({ categoryId: null, amount: -2500 })]);
});

it("Escape cancels a pending category clearing without closing the transaction editor", async () => {
  const { category, onSave, onCancel } = editCategorizedTransaction();
  fireEvent.keyDown(category, { key: "Escape" });
  expect(category).toHaveProperty("value", "Rent");
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.blur(category);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0].splits).toEqual([{ categoryId: "rent", amount: -2500 }]);
});

it("chooses another category after emptying the field without clearing the new choice", async () => {
  const { category, onSave } = editCategorizedTransaction();
  const groceries = screen.getByRole("option", { name: "Groceries" });
  fireEvent.mouseDown(groceries);
  fireEvent.mouseUp(groceries);
  fireEvent.click(groceries);
  expect(category).toHaveProperty("value", "Groceries");
  fireEvent.blur(category);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0].splits).toEqual([{ categoryId: "groceries", amount: -2500 }]);
});

it.each(["Enter", "Tab"])("selects a category with arrow keys and %s after emptying the field", async (key) => {
  const { category, onSave } = editCategorizedTransaction();
  fireEvent.keyDown(category, { key: "ArrowDown" });
  fireEvent.keyDown(category, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "Groceries" }).className).toContain("active");
  fireEvent.keyDown(category, { key });
  if (key === "Tab") fireEvent.blur(category);
  expect(category).toHaveProperty("value", "Groceries");
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByLabelText("Memo"), { key: "Enter" });
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0].splits[0].categoryId).toBe("groceries");
});

it("keeps the next future-dated row uncleared after Schedule & add another", async () => {
  setPref("newCleared", true);
  try {
    const onSave = vi.fn(async (_transaction: Transaction) => {});
    render(<TransactionEditor budget={demoBudget()} accountId="checking"
      onSave={onSave} onCancel={() => {}} onMore={() => {}} />);
    const date = screen.getByLabelText("Date");
    fireEvent.focus(date);
    fireEvent.change(date, { target: { value: "2999-01-15" } });
    fireEvent.blur(date);
    fireEvent.change(screen.getByLabelText("Inflow"), { target: { value: "25" } });
    fireEvent.keyDown(screen.getByLabelText("Inflow"), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getByLabelText("Inflow")).toHaveProperty("value", ""));
    fireEvent.change(screen.getByLabelText("Inflow"), { target: { value: "30" } });
    fireEvent.keyDown(screen.getByLabelText("Inflow"), { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0]).toMatchObject({ date: "2999-01-15", status: "uncleared" });
  } finally {
    setPref("newCleared", false);
  }
});

it("blocks an invalid date in the inline editor for both Save and Enter", async () => {
  const budget = demoBudget();
  const transaction = budget.transactions[0];
  const onSave = vi.fn(async () => {});
  render(<TransactionEditor budget={budget} accountId={transaction.accountId} initial={transaction}
    onSave={onSave} onCancel={() => {}} onMore={() => {}} />);
  const date = screen.getByLabelText("Date");
  fireEvent.focus(date);
  fireEvent.change(date, { target: { value: "2026-02-31" } });
  fireEvent.blur(date);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.keyDown(date, { key: "Enter" });
  expect(onSave).not.toHaveBeenCalled();
  expect(date).toHaveProperty("value", "2026-02-31");
  fireEvent.focus(date);
  fireEvent.change(date, { target: { value: "2026-02-28" } });
  fireEvent.keyDown(date, { key: "Enter" });
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-02-28" })));
});

it("keeps the new row's ID on retry after a failed save", async () => {
  const onSave = vi.fn().mockRejectedValueOnce(new Error("Disk unavailable")).mockResolvedValue(undefined);
  render(<TransactionEditor budget={demoBudget()} accountId="checking"
    onSave={onSave} onCancel={() => {}} onMore={() => {}} />);
  fireEvent.change(screen.getByLabelText("Inflow"), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Disk unavailable");
  const firstId = onSave.mock.calls[0][0].id;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  expect(onSave.mock.calls[1][0].id).toBe(firstId);
});

it("starts a distinct transaction after a successful Save & add another", async () => {
  const onSave = vi.fn(async (_transaction: Transaction) => {});
  const onCancel = vi.fn();
  render(<TransactionEditor budget={demoBudget()} accountId="checking"
    onSave={onSave} onCancel={onCancel} onMore={() => {}} />);
  fireEvent.change(screen.getByLabelText("Inflow"), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: "Save & add another" }));
  await waitFor(() => expect(screen.getByLabelText("Inflow")).toHaveProperty("value", ""));
  expect(onCancel).not.toHaveBeenCalled();
  const firstId = onSave.mock.calls[0][0].id;
  fireEvent.change(screen.getByLabelText("Inflow"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  expect(onSave.mock.calls[1][0].id).not.toBe(firstId);
});
