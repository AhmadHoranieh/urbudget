import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { produce } from "immer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Budget, LoanProjection, LoanTerms } from "./types";

const projection: LoanProjection = {
  months: 13,
  totalInterest: 41234,
  totalFees: 0,
  payoffDate: "2027-10-01",
  schedule: [],
};
const api = vi.hoisted(() => ({ projectLoan: vi.fn() }));
vi.mock("./bridge", () => ({ api }));
import { TransactionsPage } from "./Register";
import { CategoryLoans } from "./LoanHeader";
import { LoanPaymentForm } from "./LoanPayment";
import { LoanActionsContext, type LoanActions } from "./Planning";
import { ToastProvider } from "./ui";
import { AppliedChangeError } from "./useBudget";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.projectLoan.mockResolvedValue(projection);
});
const terms: LoanTerms = {
  accountId: "loan",
  categoryId: "car",
  annualRateBasisPoints: 650,
  monthlyPayment: 100000,
  monthlyFees: 0,
  rateHistory: [],
};
const budget = (over: Partial<Budget> = {}): Budget => ({
  schemaVersion: 2,
  name: "Test",
  currency: "SAR",
  accounts: [
    { id: "cash", name: "Checking", kind: "cash", accountType: "checking", openingBalance: 500000, archived: false },
    { id: "loan", name: "Car loan", kind: "tracking", accountType: "autoLoan", openingBalance: -1200000, archived: false },
  ],
  categories: [{ id: "car", name: "Car payment", group: "Bills", target: 0 }],
  transactions: [],
  assignments: [],
  loans: [terms],
  ...over,
});
const actions = (): LoanActions => ({ record: vi.fn(), plan: vi.fn(), details: vi.fn() });

function page(b: Budget, loanActions: LoanActions) {
  const account = b.accounts[1];
  render(
    <ToastProvider>
      <LoanActionsContext.Provider value={loanActions}>
        <TransactionsPage
          budget={b}
          accountId={account.id}
          account={account}
          summary={{ id: account.id, balance: -1200000, cleared: -1200000, uncleared: 0 }}
          netWorth={0}
          edit={vi.fn()}
          transform={vi.fn()}
          onEditAccount={vi.fn()}
          onReconcile={vi.fn()}
          onImport={vi.fn()}
          onSync={vi.fn()}
          onEdit={vi.fn()}
          onAddDialog={vi.fn()}
        />
      </LoanActionsContext.Provider>
    </ToastProvider>,
  );
}

it("shows a loan's figures over its register, with its payment and planner", async () => {
  const a = actions();
  page(budget(), a);
  const header = screen.getByRole("region", { name: "Loan" });
  expect(within(header).getByText("Owed").nextElementSibling?.textContent).toBe("12,000.00 SAR");
  expect(within(header).getByText("Rate").nextElementSibling?.textContent).toBe("6.5%");
  expect(within(header).getByText("Payment").nextElementSibling?.textContent).toBe("1,000.00 SAR");
  await waitFor(() => expect(within(header).getByText("Paid off").nextElementSibling?.textContent).toBe("Oct 2027"));
  expect(within(header).getByText("Interest to pay").nextElementSibling?.textContent).toBe("412.34 SAR");
  expect(api.projectLoan).toHaveBeenCalledWith(1200000, terms, expect.any(String), 0, 0);
  // The interest each payment adds isn't hidden.
  expect(header.textContent).toContain("Interest is added to the loan with the first payment each month.");
  fireEvent.click(within(header).getByRole("button", { name: "Record payment" }));
  expect(a.record).toHaveBeenCalledWith(expect.objectContaining({ id: "loan" }));
  fireEvent.click(within(header).getByRole("button", { name: "Payoff planner" }));
  expect(a.plan).toHaveBeenCalledWith(expect.objectContaining({ id: "loan" }));
  fireEvent.click(within(header).getByRole("button", { name: "Edit loan details" }));
  expect(a.details).toHaveBeenCalledWith(expect.objectContaining({ id: "loan" }));
});

it("asks a debt without loan details for them, and says when terms sit on another type", () => {
  const a = actions();
  page(budget({ loans: [] }), a);
  expect(screen.queryByRole("region", { name: "Loan" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add loan details" }));
  expect(a.details).toHaveBeenCalledWith(expect.objectContaining({ id: "loan" }));
  cleanup();

  // The old loan planner let any tracking account have terms: they still show, with a hint.
  const b = budget();
  b.accounts[1] = { ...b.accounts[1], accountType: "otherAsset" };
  page(b, actions());
  expect(screen.getByRole("region", { name: "Loan" }).textContent).toContain("Change its type to a loan");
  cleanup();

  page(budget({ loans: [], accounts: [budget().accounts[0], { ...budget().accounts[1], accountType: "vehicle" }] }), actions());
  expect(screen.queryByRole("button", { name: "Add loan details" })).toBeNull();
});

it("pays a loan from its payment category, and sets the payment as its target", () => {
  const a = actions();
  let current = budget();
  const edit = vi.fn((fn: (b: Budget) => void) => {
    current = produce(current, fn);
  });
  const onSaved = vi.fn();
  render(
    <LoanActionsContext.Provider value={a}>
      <CategoryLoans
        budget={current}
        category={current.categories[0]}
        balances={new Map([["loan", -1200000]])}
        edit={edit}
        onSaved={onSaved}
      />
    </LoanActionsContext.Provider>,
  );
  const card = screen.getByRole("region", { name: "Car loan loan" });
  expect(within(card).getByText("Still owed").nextElementSibling?.textContent).toBe("12,000.00 SAR");
  fireEvent.click(within(card).getByRole("button", { name: "Record payment" }));
  expect(a.record).toHaveBeenCalledWith(expect.objectContaining({ id: "loan" }));
  fireEvent.click(within(card).getByRole("button", { name: "Open planner" }));
  expect(a.plan).toHaveBeenCalledWith(expect.objectContaining({ id: "loan" }));
  fireEvent.click(within(card).getByRole("button", { name: "Use this payment as target" }));
  expect(current.categories[0]).toMatchObject({ target: 100000, goal: { goal_type: "DEBT", goal_target: 1000000 } });
  expect(onSaved).toHaveBeenCalled();
});

it("records a loan payment from a budget account, asking for a category when the loan has none", async () => {
  const record = vi.fn().mockResolvedValue(undefined);
  const b = budget();
  render(
    <LoanPaymentForm
      budget={b}
      loan={b.accounts[1]}
      terms={{ ...terms, categoryId: "" }}
      balances={new Map([["loan", { balance: -1200000 }], ["cash", { balance: 500000 }]])}
      close={vi.fn()}
      record={record}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Pay Car loan" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Pay 1,000.00 SAR" }));
  await waitFor(() => expect(within(dialog).getByText("Choose the category the payment comes from.")).toBeTruthy());
  expect(record).not.toHaveBeenCalled();
});

it("retries only saving after a loan payment is already applied", async () => {
  const retry = vi.fn().mockRejectedValueOnce(new Error("Still unavailable")).mockResolvedValue(undefined);
  const record = vi.fn().mockRejectedValue(new AppliedChangeError(retry));
  const close = vi.fn();
  const b = budget();
  render(<LoanPaymentForm budget={b} loan={b.accounts[1]} terms={terms}
    balances={new Map([["loan", { balance: -1200000 }], ["cash", { balance: 500000 }]])}
    close={close} record={record} />);
  fireEvent.click(screen.getByRole("button", { name: /^Pay / }));
  await screen.findByRole("button", { name: "Retry saving" });
  expect(screen.getByLabelText("Payment amount").matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  await screen.findByText("Still unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(retry).toHaveBeenCalledTimes(2);
  expect(record).toHaveBeenCalledTimes(1);
});
