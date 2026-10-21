import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { compile, parseAmountTerm, suggest, termLabel, type Searchable, type Term } from "./search";
import { SearchBox } from "./SearchBox";
import { demoBudget } from "./demo";

afterEach(cleanup);

const row = (over: Partial<Searchable>): Searchable => ({
  text: "",
  payee: "",
  memo: "",
  categoryIds: new Set(),
  categories: "",
  accountIds: new Set(),
  account: "",
  amount: -1000,
  flag: "",
  status: "uncleared",
  approved: true,
  ...over,
});

it("ORs chips on the same field and ANDs different fields", () => {
  const terms: Term[] = [
    { field: "payee", value: "Market" },
    { field: "payee", value: "Café" },
    { field: "amount", op: ">=", value: 2000 },
  ];
  const match = compile(terms);
  expect(match(row({ payee: "the neighborhood market", amount: -2875 }))).toBe(true);
  expect(match(row({ payee: "little café", amount: -2600 }))).toBe(true);
  expect(match(row({ payee: "little café", amount: -1500 }))).toBe(false);
  expect(match(row({ payee: "home", amount: -500000 }))).toBe(false);
});

it("matches categories by id, Unassigned, flags, status and approval", () => {
  expect(compile([{ field: "category", id: "rent", value: "Rent" }])(row({ categoryIds: new Set(["rent"]) }))).toBe(true);
  expect(compile([{ field: "category", id: "__rta", value: "Unassigned" }])(row({ categoryIds: new Set([null]) }))).toBe(
    true,
  );
  expect(compile([{ field: "flag", value: "any" }])(row({ flag: "red" }))).toBe(true);
  expect(compile([{ field: "flag", value: "none" }])(row({ flag: "red" }))).toBe(false);
  expect(compile([{ field: "status", value: "unreconciled" }])(row({ status: "cleared" }))).toBe(true);
  expect(compile([{ field: "approval", value: "needed" }])(row({ approved: false }))).toBe(true);
});

it("reads amounts and fielded queries", () => {
  expect(parseAmountTerm(">100")).toEqual({ field: "amount", op: ">=", value: 10000 });
  expect(parseAmountTerm("<= 12.5")).toEqual({ field: "amount", op: "<=", value: 1250 });
  expect(parseAmountTerm("25")).toEqual({ field: "amount", op: "=", value: 2500 });
  expect(parseAmountTerm("coffee")).toBeNull();
  const b = demoBudget();
  const labels = (q: string) => suggest(q, b, ["The neighborhood market", "Little café"]).map((s) => s.label);
  expect(labels(">50")).toEqual(["Amount ≥ 50.00 SAR"]);
  expect(labels("payee:mark")).toEqual(["Payee: The neighborhood market", "Payee: mark"]);
  expect(labels("cat:groc")).toEqual(["Category: Groceries"]);
  expect(labels("is:red")).toEqual(["Red flag"]);
  expect(labels("groc")[0]).toBe("“groc”");
  expect(labels("groc")).toContain("Category: Groceries");
  expect(termLabel({ field: "amount", op: "<=", value: 1250 })).toBe("Amount ≤ 12.50 SAR");
});

it("adds chips from suggestions, shows them in the bar, and removes them with Backspace", () => {
  const onTerms = vi.fn();
  function Harness() {
    const [text, setText] = useState("");
    const [terms, setTerms] = useState<Term[]>([]);
    return (
      <SearchBox
        budget={demoBudget()}
        text={text}
        terms={terms}
        onText={setText}
        onTerms={(t) => {
          onTerms(t);
          setTerms(t);
        }}
      />
    );
  }
  render(<Harness />);
  const input = screen.getByRole("combobox", { name: "Search transactions" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "market" } });
  fireEvent.click(screen.getByRole("option", { name: "Payee: The neighborhood market" }));
  fireEvent.change(input, { target: { value: "<30" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const chips = screen.getAllByText(/^(Payee: The neighborhood market|Amount ≤ 30\.00 SAR)$/);
  expect(chips).toHaveLength(2);
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(onTerms).toHaveBeenLastCalledWith([{ field: "payee", value: "The neighborhood market" }]);
  fireEvent.click(screen.getByRole("button", { name: "Remove Payee: The neighborhood market" }));
  expect(onTerms).toHaveBeenLastCalledWith([]);
  fireEvent.change(input, { target: { value: "rent money" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(within(input.parentElement!).getByText("“rent money”")).toBeTruthy();
});

it("finds and labels flags by the budget's names, and still by their colors", () => {
  const b = { ...demoBudget(), flagNames: { red: "Reimburse" } };
  const label = (input: string) => suggest(input, b, []).map((s) => s.label);
  expect(label("is:reimb")).toContain("Reimburse flag");
  expect(label("is:red")).toContain("Reimburse flag");
  expect(label("is:blue")).toContain("Blue flag");
  expect(termLabel({ field: "flag", value: "red" }, b)).toBe("Reimburse flag");
  expect(termLabel({ field: "flag", value: "red" })).toBe("Red flag");
});
