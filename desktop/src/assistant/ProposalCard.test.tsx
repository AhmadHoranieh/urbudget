import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { demoBudget } from "../demo";
import { money } from "../format";
import type { CardRow, Proposal, Revision } from "./api";
import { ProposalCard } from "./ProposalCard";

afterEach(cleanup);

const rows: CardRow[] = [
  {
    label: "Careem · Oct 3",
    detail: "Uncategorized → Transport",
    amount: -3800,
    key: "t:a",
    edit: { category: true, categoryId: "transport", amount: false },
  },
  {
    label: "Extra Electronics · Oct 5",
    detail: "Uncategorized → Gifts",
    amount: -89900,
    badge: "Check this",
    tone: "warn",
    key: "t:b",
    edit: { category: true, categoryId: "gifts", amount: false },
  },
  { label: "New rule: payees containing “careem”", detail: "Transport", badge: "rule", key: "r:r1" },
];
const draft = (more: Partial<Proposal> = {}): Proposal => ({
  id: "p1",
  title: "Categorize 2 transactions",
  kind: "transactions",
  status: "proposed",
  rows: 0,
  sheets: 0,
  card: { kicker: "Proposal · Transactions", rows, stats: [], more: 0, highlight: { categories: [], transactions: [] } },
  ...more,
});

/** The card as the panel keeps it: each revision made by `engine`, the card it gives shown. */
function Card({
  engine,
  onApply = vi.fn(async () => {}),
}: {
  engine: (r: Revision, p: Proposal) => Proposal;
  onApply?: () => Promise<void>;
}) {
  const [p, setP] = useState(draft());
  return (
    <ProposalCard
      proposal={p}
      budget={demoBudget()}
      canUndo
      onApply={onApply}
      onDiscard={vi.fn(async () => {})}
      onUndo={vi.fn(async () => {})}
      onReview={vi.fn()}
      onSave={vi.fn(async () => {})}
      onRevise={async (r) => setP(engine(r, p))}
    />
  );
}
/** What the engine does with a revision, as far as the card shows it. */
const marking = (r: Revision, p: Proposal): Proposal => ({
  ...p,
  choices: r.skip.length || r.set.length ? r : undefined,
  card: {
    ...p.card,
    rows: rows.map((row) => {
      const set = r.set.find((s) => s.key === row.key);
      return { ...row, skipped: r.skip.includes(row.key!), edited: !!set, amount: set?.amount ?? row.amount };
    }),
  },
});

it("leaves out a part of a change with its checkbox, and applies the rest", async () => {
  const engine = vi.fn(marking);
  const onApply = vi.fn(async () => {});
  render(<Card engine={engine} onApply={onApply} />);
  expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Apply: Extra Electronics · Oct 5" }));
  await waitFor(() => expect(engine).toHaveBeenLastCalledWith({ skip: ["t:b"], set: [] }, expect.anything()));
  expect((screen.getByRole("checkbox", { name: "Apply: Extra Electronics · Oct 5" }) as HTMLInputElement).checked).toBe(false);
  // What's applied says how much of it.
  fireEvent.click(await screen.findByRole("button", { name: "Apply 2 of 3" }));
  expect(onApply).toHaveBeenCalledTimes(1);
  // Nothing chosen: nothing to apply.
  fireEvent.click(screen.getByRole("checkbox", { name: "Apply: Careem · Oct 3" }));
  await waitFor(() => expect(engine).toHaveBeenLastCalledWith({ skip: ["t:b", "t:a"], set: [] }, expect.anything()));
  fireEvent.click(screen.getByRole("checkbox", { name: "Apply: New rule: payees containing “careem”" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Apply 0 of 3" }) as HTMLButtonElement).disabled).toBe(true));
  // And all of it again, as the assistant made it.
  fireEvent.click(screen.getByRole("button", { name: "Use the assistant's version" }));
  await waitFor(() => expect(engine).toHaveBeenLastCalledWith({ skip: [], set: [] }, expect.anything()));
  expect(await screen.findByRole("button", { name: "Apply" })).toBeTruthy();
});

it("gives a part of a change another category", async () => {
  const engine = vi.fn(marking);
  render(<Card engine={engine} />);
  // Only what can be changed has a pencil.
  expect(screen.queryByRole("button", { name: "Change New rule: payees containing “careem”" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Change Extra Electronics · Oct 5" }));
  const editor = screen.getByRole("group", { name: "Change Extra Electronics · Oct 5" });
  const category = within(editor).getByRole("combobox", { name: "Category for Extra Electronics · Oct 5" }) as HTMLInputElement;
  expect(category.value).toBe("Gifts");
  fireEvent.change(category, { target: { value: "Groc" } });
  fireEvent.click(screen.getByRole("option", { name: /Groceries/ }));
  fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(engine).toHaveBeenLastCalledWith({ skip: [], set: [{ key: "t:b", category: "groceries" }] }, expect.anything()),
  );
  expect(screen.queryByRole("group", { name: "Change Extra Electronics · Oct 5" })).toBeNull();
  // Ready to Assign is a category to give too.
  fireEvent.click(screen.getByRole("button", { name: "Change Careem · Oct 3" }));
  const ready = within(screen.getByRole("group", { name: "Change Careem · Oct 3" })).getByRole("combobox");
  fireEvent.change(ready, { target: { value: "Ready" } });
  fireEvent.click(screen.getByRole("option", { name: /Ready to assign/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(engine).toHaveBeenLastCalledWith(
      {
        skip: [],
        set: [
          { key: "t:b", category: "groceries" },
          { key: "t:a", category: null },
        ],
      },
      expect.anything(),
    ),
  );
});

it("gives a part another amount, keeping its sign, and Esc leaves it as it was", async () => {
  const engine = vi.fn((_r: Revision, p: Proposal) => p);
  const amounts: CardRow[] = [
    { label: "Home", amount: -45900, key: "s:0", edit: { category: true, categoryId: "rent", amount: true } },
    { label: "Groceries", amount: -2400, key: "s:1", edit: { category: true, categoryId: "groceries", amount: true } },
  ];
  render(
    <ProposalCard
      proposal={{ ...draft(), card: { ...draft().card, rows: amounts } }}
      budget={demoBudget()}
      canUndo
      onApply={vi.fn(async () => {})}
      onDiscard={vi.fn(async () => {})}
      onUndo={vi.fn(async () => {})}
      onReview={vi.fn()}
      onSave={vi.fn(async () => {})}
      onRevise={async (r) => void engine(r, draft())}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change Home" }));
  const amount = screen.getByLabelText("Amount for Home") as HTMLInputElement;
  expect(amount.value).toBe("-459.00");
  fireEvent.change(amount, { target: { value: "300" } });
  fireEvent.keyDown(amount, { key: "Enter" });
  await waitFor(() => expect(engine).toHaveBeenLastCalledWith({ skip: [], set: [{ key: "s:0", amount: -30000 }] }, expect.anything()));
  // Esc: nothing changes.
  fireEvent.click(screen.getByRole("button", { name: "Change Groceries" }));
  fireEvent.change(screen.getByLabelText("Amount for Groceries"), { target: { value: "+5" } });
  fireEvent.keyDown(screen.getByLabelText("Amount for Groceries"), { key: "Escape" });
  expect(screen.queryByLabelText("Amount for Groceries")).toBeNull();
  expect(engine).toHaveBeenCalledTimes(1);
  // An amount that doesn't read says so.
  fireEvent.click(screen.getByRole("button", { name: "Change Groceries" }));
  fireEvent.change(screen.getByLabelText("Amount for Groceries"), { target: { value: "lots" } });
  fireEvent.keyDown(screen.getByLabelText("Amount for Groceries"), { key: "Enter" });
  expect(screen.getByText(/Enter an amount like/)).toBeTruthy();
  expect(engine).toHaveBeenCalledTimes(1);
});

it("lists every part of a long change, a few until asked for all", () => {
  const many: CardRow[] = Array.from({ length: 30 }, (_, i) => ({ label: `Shop ${i + 1}`, amount: -(i + 1) * 100, key: `t:${i}` }));
  render(
    <ProposalCard
      proposal={{ ...draft(), card: { ...draft().card, rows: many } }}
      canUndo
      onApply={vi.fn(async () => {})}
      onDiscard={vi.fn(async () => {})}
      onUndo={vi.fn(async () => {})}
      onReview={vi.fn()}
      onSave={vi.fn(async () => {})}
      onRevise={vi.fn(async () => {})}
    />,
  );
  expect(screen.queryByText("Shop 30")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show all 30" }));
  expect(screen.getByText("Shop 30")).toBeTruthy();
  expect(screen.getByText(money(-3000))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  expect(screen.queryByText("Shop 30")).toBeNull();
});
