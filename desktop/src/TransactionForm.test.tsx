import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ScheduleDialog, TransactionForm } from "./forms";
import { demoBudget } from "./demo";
import type { Transaction } from "./types";
afterEach(cleanup);
it("editing a split preserves its IDs, flags, notes and reconciled status", async () => {
  const b = demoBudget();
  const t = {
    ...b.transactions[0],
    flag: "purple",
    status: "reconciled" as const,
    memo: "Parent",
    source: { id: "original-id" },
    splits: [
      {
        id: "part1",
        categoryId: "rent",
        amount: -300000,
        memo: "Part one",
        payee: "First payee",
      },
      {
        id: "part2",
        categoryId: "groceries",
        amount: -200000,
        memo: "Part two",
        payee: "Second payee",
      },
    ],
  };
  const save = vi.fn();
  render(
    <TransactionForm budget={b} initial={t} close={() => {}} save={save} />,
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update transaction" })));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      id: t.id,
      flag: "purple",
      memo: "Parent",
      source: { id: "original-id" },
      status: "reconciled",
      splits: t.splits,
    }),
  );
});
it("editing a tracking transfer keeps its spending category and independent statuses", async () => {
  const b = demoBudget();
  b.accounts.push({
    id: "asset",
    name: "Investment",
    kind: "tracking",
    onBudget: false,
    openingBalance: 0,
    archived: false,
  });
  const t = {
    ...b.transactions[0],
    transferAccountId: "asset",
    transferStatus: "uncleared" as const,
    status: "reconciled" as const,
  };
  const save = vi.fn();
  render(
    <TransactionForm budget={b} initial={t} close={() => {}} save={save} />,
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update transaction" })));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: t.amount,
      transferAccountId: "asset",
      status: "reconciled",
      transferStatus: "uncleared",
      splits: [
        expect.objectContaining({ categoryId: "rent", amount: t.amount }),
      ],
    }),
  );
});
it("a new transaction can repeat, which is passed to save with its frequency", async () => {
  const b = demoBudget();
  const save = vi.fn();
  render(<TransactionForm budget={b} repeatable close={() => {}} save={save} />);
  fireEvent.click(screen.getByRole("button", { name: /Inflow/ }));
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "25" } });
  fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: "monthly" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add transaction" })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ amount: 2500 }), "monthly");
});

const incomingTransfer = (): Transaction => ({
  ...demoBudget().transactions[0],
  id: "incoming-transfer",
  accountId: "savings",
  transferAccountId: "checking",
  amount: 10000,
  status: "reconciled",
  transferStatus: "uncleared",
  splits: [],
  memo: "Savings received",
  flag: "green",
  transferSource: { memo: "Checking sent", flag_color: "red" },
});

it("editing an incoming transfer keeps each account's memo, flag and cleared status", async () => {
  const save = vi.fn();
  render(<TransactionForm budget={demoBudget()} initial={incomingTransfer()} close={() => {}} save={save} />);
  expect(screen.getByPlaceholderText("Anything you want to remember")).toHaveProperty("value", "Checking sent");
  expect(screen.getByLabelText("Other account’s memo")).toHaveProperty("value", "Savings received");
  expect(screen.getByLabelText("Flag")).toHaveProperty("value", "red");
  expect(screen.getByLabelText("Other account’s flag")).toHaveProperty("value", "green");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update transaction" })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({
    accountId: "checking", transferAccountId: "savings", amount: -10000,
    memo: "Checking sent", flag: "red", status: "uncleared", transferStatus: "reconciled",
    transferSource: { memo: "Savings received", flag_color: "green" },
  }));
});

it("shows closed endpoints when editing an incoming transfer", async () => {
  const budget = demoBudget();
  budget.accounts.forEach((a) => { if (a.kind === "cash") a.archived = true; });
  const save = vi.fn();
  render(<TransactionForm budget={budget} initial={incomingTransfer()} close={() => {}} save={save} />);
  expect(screen.getByLabelText("From account")).toHaveProperty("value", "checking");
  expect(screen.getByLabelText("To account")).toHaveProperty("value", "savings");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update transaction" })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ accountId: "checking", transferAccountId: "savings" }));
});

it("uses a visible active account when a new transaction's default account is closed", async () => {
  const budget = demoBudget();
  budget.accounts.find((a) => a.id === "checking")!.archived = true;
  const save = vi.fn();
  render(<TransactionForm budget={budget} defaultAccount="checking" close={() => {}} save={save} />);
  expect(screen.getByLabelText("Account")).toHaveProperty("value", "savings");
  fireEvent.click(screen.getByRole("button", { name: /Inflow/ }));
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "25" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add transaction" })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ accountId: "savings" }));
});

it("shows a closed transfer account on a split without clearing its transfer", async () => {
  const budget = demoBudget();
  budget.accounts.find((a) => a.id === "savings")!.archived = true;
  const transaction: Transaction = {
    ...budget.transactions[0], amount: -10000,
    splits: [
      { categoryId: null, amount: -5000, transferAccountId: "savings", transferStatus: "cleared" },
      { categoryId: "rent", amount: -5000 },
    ],
  };
  const save = vi.fn();
  render(<TransactionForm budget={budget} initial={transaction} close={() => {}} save={save} />);
  expect(screen.getByLabelText("Transfer account 1")).toHaveProperty("value", "savings");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update transaction" })));
  expect(save.mock.calls[0][0].splits[0]).toMatchObject({ transferAccountId: "savings", transferStatus: "cleared" });
});

it("retries a failed new transaction save with the same ID", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("Disk unavailable")).mockResolvedValue(undefined);
  render(<TransactionForm budget={demoBudget()} close={() => {}} save={save} />);
  fireEvent.click(screen.getByRole("button", { name: /Inflow/ }));
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: "Add transaction" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Disk unavailable");
  const firstId = save.mock.calls[0][0].id;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add transaction" })));
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][0].id).toBe(firstId);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("ignores repeated submission while the transaction is saving", async () => {
  let finish!: () => void;
  const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<TransactionForm budget={demoBudget()} initial={incomingTransfer()} close={() => {}} save={save} />);
  const form = screen.getByRole("button", { name: "Update transaction" }).closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole("button", { name: "Update transaction" })).toHaveProperty("disabled", false));
});

it("does not save the previous date when the visible date is invalid", () => {
  const save = vi.fn();
  render(<TransactionForm budget={demoBudget()} initial={incomingTransfer()} close={() => {}} save={save} />);
  const date = screen.getByLabelText("Date");
  fireEvent.focus(date);
  fireEvent.change(date, { target: { value: "2026-02-31" } });
  fireEvent.blur(date);
  expect(date).toHaveProperty("value", "2026-02-31");
  fireEvent.click(screen.getByRole("button", { name: "Update transaction" }));
  expect(save).not.toHaveBeenCalled();
});

it("edits a schedule's repeat and next date without entering anything", async () => {
  const b = demoBudget();
  b.schedules = [
    {
      id: "rent",
      nextDate: "2999-01-01",
      anchorDate: "2998-12-01",
      frequency: "monthly",
      paused: true,
      transaction: { ...b.transactions[0], id: "template" },
    },
  ];
  const save = vi.fn();
  const close = vi.fn();
  render(<ScheduleDialog budget={b} schedule={b.schedules[0]} save={save} close={close} />);
  expect(screen.getByRole("dialog", { name: "Scheduled transaction" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Repeat frequency"), { target: { value: "everyOtherMonth" } });
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  // Same next date, so the pattern keeps its anchor; pausing is the register's.
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ id: "rent", frequency: "everyOtherMonth", nextDate: "2999-01-01", anchorDate: "2998-12-01", paused: true }),
  );
});

it("makes a new scheduled transaction, starting tomorrow in the register's account", async () => {
  const save = vi.fn();
  render(<ScheduleDialog budget={demoBudget()} defaultAccount="savings" save={save} close={() => {}} />);
  expect(screen.getByRole("dialog", { name: "New scheduled transaction" })).toBeTruthy();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe(tomorrow.toLocaleDateString("en-CA"));
  expect((screen.getByLabelText("Repeat frequency") as HTMLSelectElement).value).toBe("monthly");
  fireEvent.click(screen.getByRole("button", { name: /Inflow/ }));
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "25" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save schedule" })));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      frequency: "monthly",
      nextDate: tomorrow.toLocaleDateString("en-CA"),
      paused: false,
      transaction: expect.objectContaining({ accountId: "savings", amount: 2500 }),
    }),
  );
});

it("says a transaction dated ahead will be scheduled", () => {
  render(<TransactionForm budget={demoBudget()} repeatable close={() => {}} save={vi.fn()} />);
  const date = screen.getByLabelText("Date");
  fireEvent.focus(date);
  fireEvent.change(date, { target: { value: "2999-01-01" } });
  expect(screen.getByRole("button", { name: "Schedule" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Once" })).toBeTruthy();
});

it("uses an active account for a new schedule opened from a closed account", async () => {
  const budget = demoBudget();
  budget.accounts.find((a) => a.id === "checking")!.archived = true;
  const save = vi.fn();
  render(<ScheduleDialog budget={budget} defaultAccount="checking" save={save} close={() => {}} />);
  expect(screen.getByLabelText("Account")).toHaveProperty("value", "savings");
  expect(screen.queryByRole("option", { name: "Everyday account" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Inflow/ }));
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "25" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save schedule" })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({
    transaction: expect.objectContaining({ accountId: "savings", amount: 2500 }),
  }));
});

it("retains closed transfer endpoints when editing a schedule", async () => {
  const budget = demoBudget();
  budget.accounts.forEach((a) => { if (a.kind === "cash") a.archived = true; });
  const schedule = {
    id: "existing-transfer", frequency: "monthly", paused: true,
    nextDate: "2999-01-15", anchorDate: "2998-01-15", transaction: incomingTransfer(),
  };
  const save = vi.fn();
  render(<ScheduleDialog budget={budget} schedule={schedule} defaultAccount="credit" save={save} close={() => {}} />);
  expect(screen.getByLabelText("From account")).toHaveProperty("value", "checking");
  expect(screen.getByLabelText("To account")).toHaveProperty("value", "savings");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save schedule" })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({
    id: schedule.id, paused: true, nextDate: schedule.nextDate, anchorDate: schedule.anchorDate,
    transaction: expect.objectContaining({ accountId: "checking", transferAccountId: "savings", amount: -10000 }),
  }));
});
