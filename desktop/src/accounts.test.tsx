import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const api = vi.hoisted(() => ({ sourceLoanTerms: vi.fn() }));
vi.mock("./bridge", () => ({ api }));
import { accountType, inNetWorth, isLiability, isLoanType, kindForType, sectionOf } from "./accounts";
import { AccountForm } from "./forms";
import type { Account, Budget } from "./types";

afterEach(cleanup);
const account = (over: Partial<Account>): Account => ({
  id: "a",
  name: "A",
  kind: "tracking",
  openingBalance: 0,
  archived: false,
  ...over,
});

it("works out an account's type from what's set, YNAB's import, or its kind", () => {
  expect(accountType(account({ accountType: "receivable" }))).toBe("receivable");
  expect(accountType(account({ source: { type: "mortgage" } }))).toBe("mortgage");
  expect(accountType(account({ source: { type: "otherLiability" } }))).toBe("otherDebt");
  expect(accountType(account({ kind: "credit" }))).toBe("creditCard");
  expect(accountType(account({ kind: "cash" }))).toBe("checking");
  expect(accountType(account({}), -5000)).toBe("otherDebt");
  expect(accountType(account({}), 5000)).toBe("otherAsset");
  expect(kindForType("savings")).toBe("cash");
  expect(kindForType("lineOfCredit")).toBe("credit");
  expect(kindForType("vehicle")).toBe("tracking");
  expect(isLiability("autoLoan")).toBe(true);
  expect(isLoanType("mortgage")).toBe(true);
  expect(isLoanType("lineOfCredit")).toBe(false);
  expect(isLoanType("receivable")).toBe(false);
  expect(sectionOf("studentLoan")).toBe("Loans");
  expect(inNetWorth(account({ netWorth: false }))).toBe(false);
  expect(inNetWorth(account({}))).toBe(true);
});

it("sets a tracking account's type and can leave it out of net worth", () => {
  const save = vi.fn();
  render(<AccountForm close={() => {}} save={save} />);
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Loan to Sam" } });
  fireEvent.change(screen.getByLabelText("Account type"), { target: { value: "receivable" } });
  fireEvent.click(screen.getByLabelText("Count this account in net worth"));
  fireEvent.change(screen.getByLabelText("Opening balance"), { target: { value: "500" } });
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Loan to Sam",
      kind: "tracking",
      accountType: "receivable",
      netWorth: false,
      onBudget: false,
      openingBalance: 50000,
    }),
  );
});

it("budget accounts always count in net worth", () => {
  const save = vi.fn();
  render(<AccountForm close={() => {}} save={save} />);
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Savings" } });
  fireEvent.change(screen.getByLabelText("Account type"), { target: { value: "savings" } });
  expect(screen.queryByLabelText("Count this account in net worth")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "cash", accountType: "savings", netWorth: true }));
});

it.each([
  ["credit", "creditCard", "checking", "Checking"],
  ["credit", "creditCard", "otherDebt", "Other debt"],
  ["cash", "checking", "creditCard", "Credit card"],
  ["cash", "checking", "otherAsset", "Other asset"],
  ["tracking", "otherDebt", "checking", "Checking"],
  ["tracking", "otherDebt", "creditCard", "Credit card"],
] as const)("blocks an existing %s account's subtype %s from changing to %s", (kind, accountType, nextType, label) => {
  const save = vi.fn();
  render(<AccountForm initial={account({ kind, accountType })} close={() => {}} save={save} />);
  expect((screen.getByRole("option", { name: label }) as HTMLOptionElement).disabled).toBe(true);
  // A synthetic change can bypass a disabled option; submission still must not emit an invalid draft.
  fireEvent.change(screen.getByLabelText("Account type"), { target: { value: nextType } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText("Create a new account to change how this account affects your budget.")).toBeTruthy();
});

it.each([
  ["cash", "checking", "savings"],
  ["credit", "creditCard", "lineOfCredit"],
  ["tracking", "autoLoan", "mortgage"],
] as const)("allows an existing %s account to change subtype from %s to %s", (kind, accountType, nextType) => {
  const save = vi.fn();
  render(<AccountForm initial={account({ kind, accountType })} close={() => {}} save={save} />);
  fireEvent.change(screen.getByLabelText("Account type"), { target: { value: nextType } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind, accountType: nextType }));
});

it("keeps an imported tracking account's accounting kind when its source describes a credit card", () => {
  const save = vi.fn();
  const initial = account({ source: { type: "creditCard" }, openingBalance: -5000 });
  render(<AccountForm initial={initial} close={() => {}} save={save} />);
  expect((screen.getByLabelText("Account type") as HTMLSelectElement).value).toBe("otherDebt");
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Tracked card" } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Tracked card", kind: "tracking", onBudget: false }));
});

it.each([
  ["cash", "checking", "savings"],
  ["credit", "creditCard", "lineOfCredit"],
] as const)("preserves an existing %s account's explicit off-budget setting when renamed or changing subtype", (kind, accountType, nextType) => {
  const save = vi.fn();
  render(<AccountForm initial={account({ kind, accountType, onBudget: false })} close={() => {}} save={save} />);
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Renamed account" } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Renamed account", kind, accountType, onBudget: false }));
  fireEvent.change(screen.getByLabelText("Account type"), { target: { value: nextType } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ kind, accountType: nextType, onBudget: false }));
});

const loanBudget = (over: Partial<Budget> = {}): Budget => ({
  schemaVersion: 2,
  name: "Test",
  currency: "SAR",
  accounts: [account({ id: "loan", name: "Car loan", accountType: "autoLoan", openingBalance: -1200000 })],
  categories: [{ id: "car", name: "Car payment", group: "Bills", target: 0 }],
  transactions: [],
  assignments: [],
  ...over,
});

it("adds a debt's loan details with the account, and only a debt's", () => {
  const save = vi.fn();
  render(<AccountForm budget={loanBudget()} close={() => {}} save={save} />);
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Mortgage" } });
  // Not for a budget account or an asset.
  expect(screen.queryByLabelText("Interest rate")).toBeNull();
  fireEvent.change(screen.getByLabelText("Account type"), { target: { value: "vehicle" } });
  expect(screen.queryByLabelText("Interest rate")).toBeNull();
  fireEvent.change(screen.getByLabelText("Account type"), { target: { value: "mortgage" } });
  fireEvent.change(screen.getByLabelText("Opening balance"), { target: { value: "-250000" } });
  fireEvent.change(screen.getByLabelText("Interest rate"), { target: { value: "5.25" } });
  fireEvent.change(screen.getByLabelText("Monthly payment"), { target: { value: "1,850" } });
  // A mortgage's fees are its escrow.
  fireEvent.change(screen.getByLabelText("Monthly escrow"), { target: { value: "320" } });
  fireEvent.change(screen.getByLabelText("New annual rate"), { target: { value: "6.125" } });
  fireEvent.change(screen.getByLabelText("Rate change month"), { target: { value: "2028-01" } });
  fireEvent.click(screen.getByRole("button", { name: "Add rate change" }));
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  const [saved, loan] = save.mock.calls[0];
  expect(saved).toMatchObject({ kind: "tracking", accountType: "mortgage", openingBalance: -25000000 });
  expect(loan).toEqual({
    accountId: saved.id,
    categoryId: "",
    annualRateBasisPoints: 525,
    monthlyPayment: 185000,
    monthlyFees: 32000,
    rateHistory: [{ month: "2028-01", annualRateMilliPercent: 6125 }],
  });
});

it("edits saved loan details, leaves them alone when untouched, and removes them when cleared", () => {
  const terms = { accountId: "loan", categoryId: "car", annualRateBasisPoints: 650, monthlyPayment: 100000, monthlyFees: 0 };
  const b = loanBudget({ loans: [terms] });
  const save = vi.fn();
  render(<AccountForm budget={b} initial={b.accounts[0]} focusLoan close={() => {}} save={save} />);
  // Opened from "Edit loan details", it starts at them.
  expect(document.activeElement).toBe(screen.getByLabelText("Interest rate"));
  expect((screen.getByLabelText("Monthly payment") as HTMLInputElement).value).toBe("1000.00");
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save.mock.calls[0]).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Monthly payment"), { target: { value: "1200" } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save.mock.calls[1][1]).toMatchObject({ categoryId: "car", monthlyPayment: 120000 });
  fireEvent.change(screen.getByLabelText("Monthly payment"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(screen.getByText("Enter the loan's monthly payment, or clear its other details.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Interest rate"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save.mock.calls[2][1]).toBeNull();
});

it("starts an imported loan from its YNAB terms", async () => {
  api.sourceLoanTerms.mockResolvedValue({
    accountId: "loan",
    categoryId: "car",
    annualRateBasisPoints: 499,
    monthlyPayment: 45000,
    monthlyFees: 0,
    rateHistory: [],
  });
  const b = loanBudget();
  b.accounts[0].source = { type: "autoLoan" };
  const save = vi.fn();
  render(<AccountForm budget={b} initial={b.accounts[0]} close={() => {}} save={save} />);
  // Offered, not filled in: only asking for them saves them.
  fireEvent.click(await screen.findByRole("button", { name: "Use them" }));
  expect((screen.getByLabelText("Interest rate") as HTMLInputElement).value).toBe("4.99");
  expect(screen.getByText("Filled in from your YNAB import. Check them, then save.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save.mock.calls[0][1]).toMatchObject({ annualRateBasisPoints: 499, monthlyPayment: 45000, categoryId: "car" });
});

it("reads an untyped tracking account as a debt by its balance now, as the register does", () => {
  const b = loanBudget({ accounts: [account({ id: "loan", name: "Loan", openingBalance: 0 })] });
  render(<AccountForm budget={b} initial={b.accounts[0]} balance={-500000} close={() => {}} save={vi.fn()} />);
  expect(screen.getByLabelText("Interest rate")).toBeTruthy();
});

it("never saves imported terms unasked, so cleared ones stay cleared", async () => {
  api.sourceLoanTerms.mockResolvedValue({ accountId: "loan", categoryId: "car", annualRateBasisPoints: 499, monthlyPayment: 45000, monthlyFees: 0, rateHistory: [] });
  // An imported loan whose details were cleared here: renaming it keeps them cleared.
  const b = loanBudget();
  b.accounts[0].source = { type: "autoLoan" };
  const save = vi.fn();
  render(<AccountForm budget={b} initial={b.accounts[0]} close={() => {}} save={save} />);
  await screen.findByRole("button", { name: "Use them" });
  expect((screen.getByLabelText("Monthly payment") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Car loan (Toyota)" } });
  fireEvent.click(screen.getByRole("button", { name: "Update account" }));
  expect(save.mock.calls[0][1]).toBeUndefined();
});
