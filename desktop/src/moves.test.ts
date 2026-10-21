// @vitest-environment node
import { expect, it } from "vitest";
import { assignAmount, deleteCategory } from "./budgetEdits";
import { categoryMoves, monthMoveStats } from "./moves";
import type { Budget } from "./types";

const budget = (): Budget =>
  ({
    currency: "SAR",
    accounts: [],
    transactions: [],
    categories: [
      { id: "food", name: "Groceries", group: "Everyday", target: 0 },
      { id: "fun", name: "Dining out", group: "Everyday", target: 0 },
      { id: "old", name: "Coffee", group: "Everyday", target: 0 },
    ],
    assignments: [],
    moneyMoves: [],
  }) as unknown as Budget;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 16, 9, minutes));

it("logs a typed assignment as one move, however many times it is corrected", () => {
  const b = budget();
  assignAmount(b, "2026-10", "food", 50_000, at(0));
  assignAmount(b, "2026-10", "food", 45_000, at(1));
  expect(b.moneyMoves).toHaveLength(1);
  expect(b.moneyMoves![0]).toMatchObject({ kind: "assign", changes: [{ categoryId: "food", amount: 45_000 }] });
  // Later, it is a new move; typing it back to where it was removes the move.
  assignAmount(b, "2026-10", "food", 60_000, at(30));
  assignAmount(b, "2026-10", "food", 45_000, at(31));
  expect(b.moneyMoves).toHaveLength(1);
  expect(b.assignments).toEqual([{ month: "2026-10", categoryId: "food", amount: 45_000 }]);
});

it("names each move from the category's side and adds up to its Assigned", () => {
  const b = budget();
  b.assignments.push({ month: "2026-10", categoryId: "food", amount: 52_000 });
  b.moneyMoves = [
    // From before moves were itemised.
    { at: at(0).toISOString(), month: "2026-10", description: "Assigned 0.00 → 300.00 to Groceries" },
    { at: at(1).toISOString(), month: "2026-10", description: "", kind: "assign", changes: [{ categoryId: "food", amount: 50_000 }] },
    {
      at: at(2).toISOString(),
      month: "2026-10",
      description: "",
      kind: "move",
      changes: [
        { categoryId: "food", amount: -5_000 },
        { categoryId: "fun", amount: 5_000 },
      ],
    },
    { at: at(3).toISOString(), month: "2026-10", description: "", kind: "move", changes: [{ categoryId: "food", amount: 2_000 }] },
    { at: at(4).toISOString(), month: "2026-10", description: "", kind: "quickAssign", detail: "underfunded", changes: [{ categoryId: "food", amount: 4_000 }] },
    { at: at(5).toISOString(), month: "2026-09", description: "", kind: "assign", changes: [{ categoryId: "food", amount: 9_000 }] },
  ];
  const lines = categoryMoves(b, "food", "2026-10", 52_000);
  expect(lines.map((l) => [l.what, l.amount])).toEqual([
    ["Earlier changes", 1_000],
    ["Assigned", 50_000],
    ["Moved to Dining out", -5_000],
    ["Assigned", 2_000],
    ["Quick assign: underfunded", 4_000],
  ]);
  expect(categoryMoves(b, "fun", "2026-10", 5_000).map((l) => l.what)).toEqual(["Moved from Groceries"]);
  expect(monthMoveStats(b, "2026-10").get("food")).toEqual({ count: 4, moved: true });
  expect(monthMoveStats(b, "2026-10").get("fun")).toEqual({ count: 1, moved: true });
});

it("a deleted category's assignments arrive in its replacement as a merge move", () => {
  const b = budget();
  b.assignments.push({ month: "2026-10", categoryId: "old", amount: 7_500 });
  b.assignments.push({ month: "2026-10", categoryId: "fun", amount: 10_000 });
  deleteCategory(b, "old", "fun");
  const lines = categoryMoves(b, "fun", "2026-10", 17_500);
  expect(lines.map((l) => [l.what, l.amount])).toEqual([
    ["Earlier changes", 10_000],
    ["Merged from Coffee", 7_500],
  ]);
});
