import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Budget, Transaction } from "./types";

vi.mock("./bridge", () => ({
  api: {
    action: vi.fn(async (b: Budget, a: { type: string; ruleIds?: string[] }) => {
      const { reapplied } = await import("./bankNames");
      const only = a.ruleIds && new Set(a.ruleIds);
      return {
        ...b,
        transactions: b.transactions.map((t) => {
          const r = reapplied(b, t, only);
          return r ? { ...t, payee: r.payee } : t;
        }),
      };
    }),
  },
}));
import { api } from "./bridge";
import { demoBudget } from "./demo";
import { ToastProvider } from "./ui";
import { useLearnPayee } from "./useLearnPayee";

afterEach(cleanup);

function setup() {
  const b = demoBudget();
  const base = b.transactions.find((t) => t.payee === "Little café")!;
  const from = (id: string, text: string): Transaction => ({ ...base, id, payee: text, importedPayee: text });
  b.transactions.push(from("i1", "SQ *LITTLE CAFE 0042"), from("i2", "SQ *LITTLE CAFE 0077"));
  let current = b;
  const undo = vi.fn();
  const transform = async (fn: (b: Budget) => Promise<Budget>) => {
    current = await fn(current);
  };
  let learn: ReturnType<typeof useLearnPayee> = () => {};
  function Probe() {
    learn = useLearnPayee(transform, undo);
    return null;
  }
  render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );
  return { before: b, budget: () => current, learn: (before: Budget, t: Transaction) => learn(before, t) };
}

it("offers to remember a bank name after a rename, then to rename the others", async () => {
  const { before, budget, learn } = setup();
  const saved = { ...before.transactions.find((t) => t.id === "i1")!, payee: "Little café" };
  learn(before, saved);
  expect(await screen.findByText("Always use Little café for bank payees with “little cafe”?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  // (This harness doesn't save the rename itself, so both rows still have the bank's name.)
  expect(await screen.findByText("Rule added. Apply it to 2 earlier transactions too?")).toBeTruthy();
  expect(budget().payeeRules).toEqual([expect.objectContaining({ match: "little cafe", payee: "Little café", categoryId: null })]);
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(await screen.findByText("Updated 2 transactions.")).toBeTruthy();
  expect(api.action).toHaveBeenCalledWith(expect.anything(), {
    type: "reapplyPayeeRules",
    ruleIds: [budget().payeeRules![0].id],
  });
  expect(budget().transactions.filter((t) => t.payee === "Little café").map((t) => t.id)).toContain("i2");
});

it("says nothing when the payee didn't change or the rules already give that name", () => {
  const { before, learn } = setup();
  const t = before.transactions.find((x) => x.id === "i1")!;
  learn(before, { ...t, memo: "lunch" });
  learn({ ...before, payeeRules: [{ id: "r", match: "sq little cafe", payee: "Little café", categoryId: null }] }, { ...t, payee: "Little café" });
  expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
});
