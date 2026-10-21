import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
  addCategory,
  addGroup,
  deleteCategory,
  deleteGroup,
  moveCategory,
  moveGroup,
  renameGroup,
  setHidden,
  stepCategory,
} from "./budgetEdits";
import { orderedGroups } from "./categories";
import type { Budget, Transaction } from "./types";

const cat = (id: string, group: string) => ({ id, name: id, group, target: 0 });
const tx = (id: string, categoryId: string): Transaction => ({
  id,
  date: "2026-10-01",
  accountId: "cash",
  payee: "Shop",
  memo: "",
  amount: -100,
  status: "uncleared",
  splits: [{ categoryId, amount: -100 }],
  transferAccountId: null,
  transferStatus: null,
});
const base: Budget = {
  schemaVersion: 2,
  name: "Home",
  currency: "SAR",
  accounts: [{ id: "cash", name: "Cash", kind: "cash", openingBalance: 0, archived: false }],
  categories: [cat("rent", "Bills"), cat("power", "Bills"), cat("food", "Living"), cat("fun", "Living")],
  transactions: [tx("t1", "food"), tx("t2", "rent")],
  assignments: [
    { month: "2026-10", categoryId: "food", amount: 300 },
    { month: "2026-10", categoryId: "fun", amount: 50 },
    { month: "2026-11", categoryId: "food", amount: 200 },
  ],
  schedules: [
    {
      id: "s",
      nextDate: "2026-11-01",
      anchorDate: "2026-11-01",
      frequency: "monthly",
      paused: false,
      transaction: tx("st", "food"),
    },
  ],
  payeeRules: [{ id: "r", match: "SHOP", payee: "Shop", categoryId: "food" }],
  loans: [{ accountId: "cash", categoryId: "food", annualRateBasisPoints: 0, monthlyPayment: 0, monthlyFees: 0 }],
};
const layout = (b: Budget) => orderedGroups(b, { empty: true }).map((g) => `${g.name}: ${g.categories.map((c) => c.id).join(",")}`);

describe("category and group edits", () => {
  it("deleting a category moves its history and merges its assignments", () => {
    const b = produce(base, (d) => deleteCategory(d, "food", "fun"));
    expect(b.categories.map((c) => c.id)).not.toContain("food");
    expect(b.transactions[0].splits[0].categoryId).toBe("fun");
    expect(b.schedules![0].transaction.splits[0].categoryId).toBe("fun");
    expect(b.payeeRules![0].categoryId).toBe("fun");
    expect(b.loans![0].categoryId).toBe("fun");
    expect(b.assignments).toEqual([
      { month: "2026-10", categoryId: "fun", amount: 350 },
      { month: "2026-11", categoryId: "fun", amount: 200 },
    ]);
  });
  it("deleting into Unassigned releases assignments and unpairs loan terms", () => {
    const b = produce(base, (d) => deleteCategory(d, "food", null));
    expect(b.transactions[0].splits[0].categoryId).toBeNull();
    // Moved there on purpose, so it doesn't then ask for a category.
    expect(b.transactions[0].splits[0].unassigned).toBe(true);
    expect(b.assignments.map((a) => a.categoryId)).toEqual(["fun"]);
    expect(b.loans).toEqual([{ ...base.loans![0], categoryId: "" }]);
  });
  it("adds categories at the end of their group, and empty groups", () => {
    const b = produce(base, (d) => {
      addCategory(d, "Bills", "Water");
      addGroup(d, "Savings");
    });
    const added = b.categories.at(-1)!.id;
    expect(layout(b)).toEqual(["Bills: rent,power," + added, "Living: food,fun", "Savings: "]);
    expect(produce(b, (d) => void addGroup(d, "Bills"))).toBe(b);
  });
  it("renames, merges and deletes groups", () => {
    const renamed = produce(base, (d) => renameGroup(d, "Bills", "Housing"));
    expect(layout(renamed)).toEqual(["Housing: rent,power", "Living: food,fun"]);
    const merged = produce(base, (d) => renameGroup(d, "Bills", "Living"));
    expect(layout(merged)).toEqual(["Living: rent,power,food,fun"]);
    const deleted = produce(base, (d) => deleteGroup(d, "Bills", "Living"));
    expect(layout(deleted)).toEqual(["Living: rent,power,food,fun"]);
    const refused = produce(base, (d) => deleteGroup(d, "Bills"));
    expect(layout(refused)).toEqual(layout(base));
  });
  it("moves categories and groups by drag or step", () => {
    const dragged = produce(base, (d) => moveCategory(d, "fun", "Bills", "power"));
    expect(layout(dragged)).toEqual(["Bills: rent,fun,power", "Living: food"]);
    const stepped = produce(base, (d) => stepCategory(d, "food", -1));
    expect(layout(stepped)).toEqual(["Bills: rent,power,food", "Living: fun"]);
    const down = produce(base, (d) => stepCategory(d, "power", 1));
    expect(layout(down)).toEqual(["Bills: rent", "Living: power,food,fun"]);
    const groups = produce(base, (d) => moveGroup(d, "Living", "Bills"));
    expect(layout(groups)).toEqual(["Living: food,fun", "Bills: rent,power"]);
  });
  it("hides categories into their own display group", () => {
    const b = produce(base, (d) => setHidden(d, ["power"], true));
    expect(layout(b)).toEqual(["Bills: rent", "Living: food,fun", "Hidden categories: power"]);
  });
});
