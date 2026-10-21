import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Each option moves a few assignments the way the Rust action would; the others change nothing.
const changes: Record<string, Record<string, number>> = {
  spentLastMonth: { groceries: 150000, dining: 160000 },
  resetAssigned: { groceries: 0, dining: 0, rent: 0 },
};
const MODES = ["underfunded", "assignedLastMonth", "spentLastMonth", "averageAssigned", "averageSpent", "reduceOverfunding", "resetAvailable", "resetAssigned"];
vi.mock("./bridge", () => ({
  api: {
    action: vi.fn(async (b: Budget, action: { mode: string; month: string }) =>
      produce(b, (d) => {
        for (const [id, amount] of Object.entries(changes[action.mode] ?? {})) {
          d.assignments.find((a) => a.month === action.month && a.categoryId === id)!.amount = amount;
        }
      }),
    ),
    // Every option at once, as the Rust preview reports them: the categories each would change.
    autoAssignPreview: vi.fn(async (b: Budget, month: string, categories: string[]) =>
      Object.fromEntries(
        MODES.map((mode) => [
          mode,
          Object.entries(changes[mode] ?? {})
            .filter(([id]) => categories.includes(id))
            .map(([id, after]) => ({ id, before: b.assignments.find((a) => a.month === month && a.categoryId === id)?.amount ?? 0, after }))
            .filter((c) => c.after !== c.before),
        ]),
      ),
    ),
    autoAssignResult: vi.fn(async (b: Budget, month: string, mode: string) => {
      const available: Record<string, number> = { groceries: 50000, dining: 10000, rent: 0 };
      let total = 0;
      const categories = b.categories.map((c) => {
        const before = b.assignments.find((a) => a.month === month && a.categoryId === c.id)?.amount ?? 0;
        const after = changes[mode]?.[c.id] ?? before;
        total += after - before;
        return { id: c.id, assigned: after, available: (available[c.id] ?? 0) + after - before, activity: 0, carried: 0 };
      });
      return { readyToAssign: 100000 - total, assigned: 0, available: 0, activity: 0, income: 0, netWorth: 0, accounts: [], categories };
    }),
  },
}));
import { QuickAssign, autoAssignAction } from "./QuickAssign";
import { api } from "./bridge";
import type { CategorySummary } from "./CategoryRow";
import { demoBudget } from "./demo";
import { shiftMonth, monthOnly } from "./format";
import { today, type Budget } from "./types";

beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("retries transient preview errors and does not cache failed requests across remounts", async () => {
  const preview = vi.mocked(api.autoAssignPreview);
  preview.mockRejectedValueOnce(new Error("Temporary read failure"));
  const b = demoBudget();
  const node = <QuickAssign budget={b} month={today().slice(0, 7)} ids={["groceries"]} all
    summaries={new Map()} readyToAssign={10000} onApply={() => {}} />;
  const first = render(node);
  await screen.findByRole("button", { name: "Retry preview" });
  const calls = preview.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
  await screen.findAllByText("No change");
  expect(preview.mock.calls.length).toBe(calls + 1);
  first.unmount();
  preview.mockRejectedValueOnce(new Error("Another temporary read failure"));
  const b2 = { ...b };
  const second = render(<QuickAssign budget={b2} month={today().slice(0, 7)} ids={["groceries"]} all
    summaries={new Map()} readyToAssign={10000} onApply={() => {}} />);
  await screen.findByRole("button", { name: "Retry preview" });
  second.unmount();
  const failedCalls = preview.mock.calls.length;
  render(<QuickAssign budget={b2} month={today().slice(0, 7)} ids={["groceries"]} all
    summaries={new Map()} readyToAssign={10000} onApply={() => {}} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  expect(preview.mock.calls.length).toBe(failedCalls + 1);
  expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
});
const month = today().slice(0, 7);

function setup() {
  const onApply = vi.fn();
  const summary = (id: string, assigned: number, available: number): [string, CategorySummary] => [
    id,
    { id, assigned, activity: 0, available, carried: 0 },
  ];
  render(
    <QuickAssign
      budget={demoBudget()}
      month={month}
      ids={["groceries", "dining", "rent"]}
      all
      summaries={new Map([summary("groceries", 180000, 50000), summary("dining", 120000, 10000), summary("rent", 500000, 0)])}
      readyToAssign={100000}
      onApply={onApply}
    />,
  );
  return { onApply };
}

it("previews an option with the budget's numbers and applies it only when confirmed", async () => {
  const { onApply } = setup();
  const row = (await screen.findByText("+100.00 SAR")).closest("button")!;
  expect(screen.getByRole("button", { name: /Underfunded/ })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: /Underfunded/ }).textContent).toContain("No change");

  fireEvent.click(row);
  const dialog = screen.getByRole("dialog", { name: "Quick assign: Spent last month" });
  await within(dialog).findByRole("button", { name: "Apply to 2 categories" });
  expect(dialog.textContent).toContain(`what it spent in ${monthOnly(shiftMonth(month, -1))}`);
  // Unassigned after: 1,000.00 less the 100.00 it assigns.
  expect(dialog.textContent).toContain("900.00 SAR");
  // The example and the first row are the biggest change, with real amounts.
  expect(within(dialog).getByText(/^Dining out spent 1,600\.00 SAR in/)).toBeTruthy();
  const rows = within(dialog).getAllByRole("row").slice(1);
  expect(rows.map((r) => r.textContent)).toEqual([
    "Dining out1,200.00 SAR → 1,600.00 SAR+400.00 SAR500.00 SAR",
    "Groceries1,800.00 SAR → 1,500.00 SAR−300.00 SAR200.00 SAR",
  ]);
  expect(dialog.textContent).toContain("1 category stays the same.");

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onApply).not.toHaveBeenCalled();

  fireEvent.click(row);
  fireEvent.click(await screen.findByRole("button", { name: "Apply to 2 categories" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onApply).toHaveBeenCalledWith("spentLastMonth", "Spent last month", 10000, today().slice(0, 7));
});

it("carries the confirmed reference month into the queued action without changing legacy callers", () => {
  expect(autoAssignAction("underfunded", "2026-11", ["food"], true, "2026-10")).toEqual({
    type: "autoAssign", month: "2026-11", mode: "underfunded", categories: ["food"], limitToAvailable: true, expectedAsOfMonth: "2026-10",
  });
  expect(autoAssignAction("underfunded", "2026-11", ["food"], true)).not.toHaveProperty("expectedAsOfMonth");
});

it("makes a reset look like one: Cancel has focus and overspending is called out", async () => {
  const { onApply } = setup();
  await screen.findByText("+100.00 SAR");
  fireEvent.click(screen.getByRole("button", { name: /Reset assigned amounts/ }));
  const dialog = screen.getByRole("dialog", { name: "Quick assign: Reset assigned amounts" });
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect((await within(dialog).findByRole("button", { name: "Apply to 3 categories" })).className).toBe("danger");
  expect(within(dialog).getByRole("alert").textContent).toContain("3 categories end up overspent");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
});

it("refreshes a mounted preview at rollover and does not reuse a pre-rollover cache after remount", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T23:59:50"));
  const preview = vi.mocked(api.autoAssignPreview);
  const values = (amount: number) => ({ underfunded: [{ id: "groceries", before: 0, after: amount }] });
  preview.mockResolvedValueOnce(values(10000)).mockResolvedValueOnce(values(5000)).mockResolvedValueOnce(values(4000));
  const props = { budget: demoBudget(), month: "2026-11", ids: ["groceries"], all: true, summaries: new Map(), readyToAssign: 10000, onApply: vi.fn() };
  const first = render(<QuickAssign {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(screen.getByRole("button", { name: /Underfunded/ }).textContent).toContain("+100.00 SAR");
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(screen.getByRole("button", { name: /Underfunded/ }).textContent).toContain("+50.00 SAR");
  expect(preview).toHaveBeenCalledTimes(2);
  first.unmount();
  vi.setSystemTime(new Date("2026-12-01T08:00:00"));
  render(<QuickAssign {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(screen.getByRole("button", { name: /Underfunded/ }).textContent).toContain("+40.00 SAR");
  expect(preview).toHaveBeenCalledTimes(3);
  expect(api.autoAssignResult).not.toHaveBeenCalled();
});

it("uses the resulting native RTA and future shortage when returned funds are still reserved", async () => {
  const b = demoBudget();
  vi.mocked(api.autoAssignPreview).mockResolvedValueOnce({ resetAvailable: [{ id: "groceries", before: 5000, after: 0 }] });
  vi.mocked(api.autoAssignResult).mockResolvedValueOnce({ readyToAssign: 0, futureReadyToAssign: -5000, futureShortfalls: [{ month: "2026-11", amount: 5000 }],
    assigned: 0, available: 0, activity: 0, income: 0, netWorth: 0, accounts: [], categories: [{ id: "groceries", assigned: 0, activity: 0, available: 0, carried: 0 }] });
  render(<QuickAssign budget={b} month="2026-10" ids={["groceries"]} all summaries={new Map([["groceries", { id: "groceries", assigned: 5000, activity: 0, available: 5000, carried: 0 }]])} readyToAssign={0} onApply={vi.fn()} />);
  await screen.findByText("−50.00 SAR");
  expect(api.autoAssignResult).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Reset available amounts/ }));
  const dialog = screen.getByRole("dialog");
  await within(dialog).findByRole("button", { name: "Apply to 1 category" });
  const unassigned = [...dialog.querySelectorAll(".qa-stats > div")].find((node) => node.querySelector("span")?.textContent === "Unassigned");
  expect(unassigned?.querySelector("strong")?.textContent).toBe("0.00 SAR");
  expect(within(dialog).getByRole("alert").textContent).toContain("November is short by 50.00 SAR");
  expect(dialog.textContent).not.toContain("back to Unassigned");
  expect(api.autoAssignResult).toHaveBeenCalledTimes(1);
});

it("blocks confirmation until the resulting summary succeeds and offers a separate result retry", async () => {
  vi.mocked(api.autoAssignResult).mockRejectedValueOnce(new Error("Temporary calculation failure"));
  const { onApply } = setup();
  await screen.findByText("+100.00 SAR");
  fireEvent.click(screen.getByRole("button", { name: /Spent last month/ }));
  const retry = await screen.findByRole("button", { name: "Retry result" });
  expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true);
  fireEvent.click(retry);
  const apply = await screen.findByRole("button", { name: "Apply to 2 categories" });
  expect(apply).toHaveProperty("disabled", false);
  expect(onApply).not.toHaveBeenCalled();
});

it("does not invent Available amounts when the resulting summary is incomplete", async () => {
  vi.mocked(api.autoAssignResult).mockResolvedValueOnce({ readyToAssign: 0, assigned: 0, available: 0, activity: 0, income: 0, netWorth: 0, accounts: [], categories: [] });
  const { onApply } = setup();
  await screen.findByText("+100.00 SAR");
  fireEvent.click(screen.getByRole("button", { name: /Spent last month/ }));
  await screen.findByRole("button", { name: "Retry result" });
  expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("table", { name: "Changes by category" })).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
});
