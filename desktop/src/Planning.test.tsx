import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { today, type Budget, type LoanProjection, type LoanTerms } from "./types";
import { monthName } from "./format";

/** loans.rs's projection, simplified: monthly interest on the balance, then the payment (the
 * first with the one-off `lump`). */
function project(balance: number, terms: LoanTerms, start: string, extra: number, lump = 0): LoanProjection {
  const schedule: LoanProjection["schedule"] = [];
  const [y, m] = start.split("-").map(Number);
  while (balance > 0) {
    if (schedule.length >= 1200) throw new Error("This payment takes more than 100 years to repay the loan.");
    const interest = Math.round((balance * terms.annualRateBasisPoints * 10) / 1200000);
    const once = schedule.length ? 0 : lump;
    const payment = Math.min(terms.monthlyPayment + extra + once, balance + interest + terms.monthlyFees);
    if (payment <= interest + terms.monthlyFees) throw new Error("Payment does not cover monthly interest and fees. Increase the payment.");
    balance -= payment - interest - terms.monthlyFees;
    const d = new Date(y, m - 1 + schedule.length, 1);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    schedule.push({ date, payment, interest, fees: terms.monthlyFees, principal: payment - interest - terms.monthlyFees, balance });
  }
  return {
    months: schedule.length,
    totalInterest: schedule.reduce((n, r) => n + r.interest, 0),
    totalFees: schedule.reduce((n, r) => n + r.fees, 0),
    payoffDate: schedule.at(-1)?.date ?? start,
    schedule,
  };
}
const api = vi.hoisted(() => ({
  projectLoan: vi.fn(),
  loanPaymentByDate: vi.fn(),
  recordLoanPayment: vi.fn(),
}));
vi.mock("./bridge", () => ({ api }));
import { LoanPlanner, span } from "./LoanPlanner";
import { nextPayment, parseRate, parseRateChange, percent, rateIn, rateText, useProjection } from "./Planning";
import { configureFormat } from "./format";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.projectLoan.mockImplementation(async (b: number, t: LoanTerms, s: string, e: number, l = 0) => project(b, t, s, e, l));
  api.loanPaymentByDate.mockResolvedValue(150000);
});
const terms: LoanTerms = {
  accountId: "loan",
  categoryId: "c",
  annualRateBasisPoints: 600,
  monthlyPayment: 100000,
  monthlyFees: 0,
  rateHistory: [],
};
const budget: Budget = {
  schemaVersion: 2,
  name: "Test",
  currency: "SAR",
  accounts: [
    { id: "cash", name: "Checking", kind: "cash", openingBalance: 500000, archived: false },
    { id: "loan", name: "Car loan", kind: "tracking", accountType: "autoLoan", openingBalance: -1200000, archived: false },
  ],
  categories: [{ id: "c", name: "Car payment", group: "Bills", target: 0 }],
  transactions: [],
  assignments: [],
  loans: [terms],
};

it("reads rates the way loans.rs does", () => {
  const t = { ...terms, rateHistory: [{ month: "2026-03", annualRateMilliPercent: 5125 }] };
  expect(rateIn(t, "2026-02")).toBe(6000);
  expect(rateIn(t, "2026-03")).toBe(5125);
  expect(percent(5125)).toBe("5.125%");
  expect(parseRate("5.25")).toBe(525);
  expect(() => parseRate("1200")).toThrow(/0 to 1,000%/);
  expect(parseRateChange("4.875")).toBe(4875);
  expect(span(14)).toBe("1 year 2 months");
});

it("reads and writes rates with the budget's decimal mark", () => {
  configureFormat({ currency: "EUR", numberFormat: { decimal: ",", group: ".", symbol: "after" } });
  try {
    expect(rateText(525)).toBe("5,25");
    expect(parseRate("5,25")).toBe(525);
    expect(parseRate("5.25")).toBe(525);
    expect(parseRateChange("4,875")).toBe(4875);
  } finally {
    configureFormat({ currency: "SAR" });
  }
});

it("projects from today until this month's payment is in, then from next month", () => {
  expect(nextPayment(budget, "loan", "2026-10-19")).toBe("2026-10-19");
  const paid: Budget = {
    ...budget,
    transactions: [
      {
        id: "p",
        date: "2026-10-02",
        accountId: "cash",
        payee: "",
        memo: "",
        amount: -100000,
        status: "cleared",
        splits: [{ categoryId: "c", amount: -100000 }],
        transferAccountId: "loan",
        transferStatus: "cleared",
      },
    ],
  };
  expect(nextPayment(paid, "loan", "2026-10-19")).toBe("2026-11-01");
});

it("tries an extra payment, a one-off and a payoff date without changing anything", async () => {
  const close = vi.fn();
  render(<LoanPlanner budget={budget} account={budget.accounts[1]} terms={terms} balance={-1200000} close={close} />);
  const dialog = screen.getByRole("dialog", { name: "Payoff planner · Car loan" });
  // The current plan: 12,000 at 6% and 1,000 a month.
  await waitFor(() => expect(within(dialog).getAllByRole("table")[0].textContent).toContain("1 year 1 month"));
  expect(api.projectLoan).toHaveBeenCalledWith(1200000, terms, expect.any(String), 0, 0);

  fireEvent.change(within(dialog).getByLabelText("Extra each month"), { target: { value: "500" } });
  await waitFor(() => expect(within(dialog).getByText("Time saved")).toBeTruthy());
  expect(api.projectLoan).toHaveBeenCalledWith(1200000, terms, expect.any(String), 50000, 0);
  const saved = within(dialog).getByText("Interest saved").nextElementSibling!.textContent;
  expect(saved).toBe("128.85 SAR");
  expect(within(dialog).getByRole("columnheader", { name: "With changes" })).toBeTruthy();

  // With this month's payment still to come, a one-off now goes in with it, after its interest.
  fireEvent.change(within(dialog).getByLabelText("One-off payment"), { target: { value: "2000" } });
  await waitFor(() => expect(api.projectLoan).toHaveBeenCalledWith(1200000, terms, expect.any(String), 50000, 200000));

  // A payoff date gives the payment that does it, tried as the extra.
  fireEvent.change(within(dialog).getByLabelText("Pay off by"), { target: { value: "2027-06-30" } });
  fireEvent.blur(within(dialog).getByLabelText("Pay off by"));
  await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("pay 1,500.00 SAR a month: 500.00 SAR more than now"));
  expect(api.loanPaymentByDate).toHaveBeenCalledWith(1200000, terms, expect.any(String), "2027-06-30", 200000);
  expect((within(dialog).getByLabelText("Extra each month") as HTMLInputElement).value).toBe("500.00");

  // The schedule lists every payment of the plan being tried.
  expect(within(dialog).getByText(/Payment schedule \(\d+ payments\)/)).toBeTruthy();
  expect(api.recordLoanPayment).not.toHaveBeenCalled();
});

it("adds the month's interest before a one-off payment, as recording one does", async () => {
  render(<LoanPlanner budget={budget} account={budget.accounts[1]} terms={terms} balance={-1200000} close={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Payoff planner · Car loan" });
  const paidOff = () => within(dialog).getByText("Paid off", { selector: "span" }).nextElementSibling!.textContent;
  // 12,000 at 6%, this month's payment still to come: paying 12,000 leaves the month's 60 of
  // interest for that payment to clear.
  fireEvent.change(within(dialog).getByLabelText("One-off payment"), { target: { value: "12000" } });
  await waitFor(() => expect(paidOff()).toBe(monthName(today().slice(0, 7))));
  fireEvent.change(within(dialog).getByLabelText("One-off payment"), { target: { value: "12060" } });
  await waitFor(() => expect(paidOff()).toBe("Now"));
});

it("says when the payment doesn't cover the interest", async () => {
  render(
    <LoanPlanner
      budget={budget}
      account={budget.accounts[1]}
      terms={{ ...terms, monthlyPayment: 1000 }}
      balance={-1200000}
      close={() => {}}
    />,
  );
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/does not cover monthly interest/));
});

it("only shows a projection or error for the current loan inputs", async () => {
  const pending: { resolve: (value: LoanProjection) => void; reject: (error: Error) => void }[] = [];
  api.projectLoan.mockImplementation(() => new Promise<LoanProjection>((resolve, reject) => pending.push({ resolve, reject })));
  const { result, rerender } = renderHook(({ owed, extra }) => useProjection(owed, terms, "2026-10-20", extra), {
    initialProps: { owed: 1200000, extra: 0 },
  });
  await waitFor(() => expect(pending).toHaveLength(1));
  const base = project(1200000, terms, "2026-10-20", 0);
  await act(async () => pending[0].resolve(base));
  expect(result.current.projection).toBe(base);

  rerender({ owed: 1200000, extra: 50000 });
  expect(result.current).toEqual({ projection: null, error: "" });
  await waitFor(() => expect(pending).toHaveLength(2));
  rerender({ owed: 1100000, extra: 50000 });
  await waitFor(() => expect(pending).toHaveLength(3));
  await act(async () => pending[1].resolve(base));
  expect(result.current).toEqual({ projection: null, error: "" });
  await act(async () => pending[2].reject(new Error("Current projection failed")));
  expect(result.current.error).toBe("Current projection failed");

  rerender({ owed: 1100000, extra: 60000 });
  expect(result.current).toEqual({ projection: null, error: "" });
  await waitFor(() => expect(pending).toHaveLength(4));
  rerender({ owed: 0, extra: 60000 });
  await act(async () => pending[3].resolve(base));
  expect(result.current).toEqual({ projection: null, error: "" });
});

it("does not label an old required payment with a newly selected payoff date", async () => {
  render(<LoanPlanner budget={budget} account={budget.accounts[1]} terms={terms} balance={-1200000} close={() => {}} />);
  const date = screen.getByLabelText("Pay off by");
  fireEvent.change(date, { target: { value: "2027-06-30" } });
  fireEvent.blur(date);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("pay 1,500.00 SAR"));

  let resolve!: (amount: number) => void;
  api.loanPaymentByDate.mockImplementation(() => new Promise<number>((done) => { resolve = done; }));
  fireEvent.change(date, { target: { value: "2027-03-31" } });
  fireEvent.blur(date);
  expect(screen.queryByRole("status")).toBeNull();
  await waitFor(() => expect(api.loanPaymentByDate).toHaveBeenLastCalledWith(1200000, terms, expect.any(String), "2027-03-31", 0));
  await act(async () => resolve(200000));
  expect(screen.getByRole("status").textContent).toContain("pay 2,000.00 SAR");
  expect(screen.getByRole("status").textContent).toContain(monthName("2027-03"));
});
