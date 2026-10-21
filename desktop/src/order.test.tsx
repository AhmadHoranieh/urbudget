import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./bridge", () => ({ api: {} }));
import { categoryActivity } from "./ActivityPopover";
import { demoBudget } from "./demo";
import { byAdded, newestFirst } from "./order";
import { Register, registerEntries } from "./Register";
import { reportLines } from "./reports/TransactionsDialog";
import { TransactionEditor } from "./TransactionRow";
import { ToastProvider } from "./ui";
import type { Budget, Transaction } from "./types";

afterEach(cleanup);

/** A grocery purchase in checking, added at `createdAt` (none: from before the app kept it). */
const purchase = (payee: string, amount: number, createdAt?: string, date = "2026-10-15"): Transaction => ({
  id: payee,
  date,
  accountId: "checking",
  payee,
  memo: "",
  amount,
  status: "cleared",
  splits: [{ categoryId: "groceries", amount }],
  transferAccountId: null,
  transferStatus: null,
  ...(createdAt ? { createdAt } : {}),
});
const budgetWith = (transactions: Transaction[]): Budget => ({ ...demoBudget(), transactions, schedules: [] });
// Saved in this order: the one added second comes first.
const sameDay = () =>
  budgetWith([
    purchase("Added second", -3000, "2026-10-15T09:00:00.200Z"),
    purchase("Added first", -2000, "2026-10-15T09:00:00.100Z"),
    purchase("Day before", -1000, "2026-10-19T08:00:00.000Z", "2026-10-14"),
  ]);
const payees = () =>
  screen
    .getAllByRole("row")
    .filter((r) => r.hasAttribute("aria-selected"))
    .map((r) => r.querySelector("[data-field=Payee]")?.textContent);

it("shows the transaction added second above the first on their date, and below it oldest first", () => {
  const b = sameDay();
  const rows = registerEntries(b, "checking");
  expect(rows.map((r) => r.t.payee)).toEqual(["Added second", "Added first", "Day before"]);
  // The running balance adds up from the oldest: each is the one below it plus the row's amount.
  const opening = b.accounts.find((a) => a.id === "checking")!.openingBalance;
  expect(rows.map((r) => r.balance)).toEqual([opening - 6000, opening - 3000, opening - 1000]);

  render(
    <ToastProvider>
      <Register budget={b} accountId="checking" edit={() => {}} transform={async () => {}} onEdit={() => {}} />
    </ToastProvider>,
  );
  expect(payees()).toEqual(["Added second", "Added first", "Day before"]);
  fireEvent.click(screen.getByRole("button", { name: "Date" }));
  expect(payees()).toEqual(["Day before", "Added first", "Added second"]);
});

it("keeps transactions without a time in the order they always had, older than ones with one", () => {
  // Saved b then a: before the app kept a time, the register ordered a day by id, and still does.
  const b = budgetWith([purchase("Stamped", -500, "2026-10-15T08:00:00.000Z"), purchase("Old b", -100), purchase("Old a", -200)]);
  expect(registerEntries(b, "checking").map((r) => r.t.payee)).toEqual(["Stamped", "Old b", "Old a"]);
  expect(byAdded({ id: "z", date: "2026-10-15" }, { id: "a", date: "2026-10-15", createdAt: "2000-01-01T00:00:00.000Z" })).toBe(-1);
  expect(byAdded({ id: "a", date: "2026-10-16" }, { id: "z", date: "2026-10-15", createdAt: "2030-01-01T00:00:00.000Z" })).toBe(1);
  // Added at the same moment: the order they're saved in.
  const list = [1, 2, 3];
  const at = { date: "2026-10-15", createdAt: "2026-10-15T08:00:00.000Z" };
  expect(newestFirst(list, (n) => ({ id: String(4 - n), ...at }))).toEqual([3, 2, 1]);
  expect(list).toEqual([1, 2, 3]);
});

it("lists a category's activity and a report's transactions like the register", () => {
  const b = sameDay();
  expect(categoryActivity(b, "groceries", "2026-10").map((l) => l.payee)).toEqual(["Added second", "Added first", "Day before"]);
  const lines = reportLines(b, { from: "2026-10-01", to: "2026-10-31", categoryIds: new Set(["groceries"]) });
  expect(lines.map((l) => l.payee)).toEqual(["Added second", "Added first", "Day before"]);
});

it("keeps when a transaction was added when the row editor saves an edit", async () => {
  const b = sameDay();
  const onSave = vi.fn(async (_t: Transaction) => {});
  render(
    <TransactionEditor budget={b} accountId="checking" initial={b.transactions[1]} onSave={onSave} onCancel={() => {}} onMore={() => {}} />,
  );
  fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "Edited" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave.mock.calls[0][0]).toMatchObject({ memo: "Edited", createdAt: "2026-10-15T09:00:00.100Z" });
});
