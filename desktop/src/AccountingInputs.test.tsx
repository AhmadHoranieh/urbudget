import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TransactionForm } from "./forms";
import { demoBudget } from "./demo";
import { splitRole } from "./accounting";
import type { Transaction } from "./types";

afterEach(cleanup);

it("persists clearing explicit RTA as missing categorization", async () => {
  const budget = demoBudget();
  const initial = { ...budget.transactions[0], status: "cleared" as const,
    splits: [{ amount: budget.transactions[0].amount, categoryId: null, unassigned: true,
      source: { category_id: "rta", category_name: "Inflow: Ready to Assign" } }] };
  const save = vi.fn();
  render(<TransactionForm budget={budget} initial={initial} close={() => {}} save={save} />);
  const category = screen.getByRole("combobox", { name: "Category 1" });
  fireEvent.focus(category);
  fireEvent.change(category, { target: { value: "" } });
  fireEvent.blur(category);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update transaction" })));
  expect(save).toHaveBeenCalled();
  const saved = save.mock.calls[0][0] as Transaction;
  expect(saved.splits[0]).toMatchObject({ categoryId: null, unassigned: false });
  expect(splitRole(saved, saved.splits[0], saved.splits[0].amount)).toBe("uncategorized");
});
