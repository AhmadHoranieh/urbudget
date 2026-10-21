import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryRow, categoryState, targetSentence, targetText, type CategorySummary } from "./CategoryRow";
import { BudgetInspector } from "./BudgetInspector";
import { configureFormat, deadline, money, ordinal } from "./format";
import { demoBudget } from "./demo";
import type { Budget, Category, Summary } from "./types";

vi.mock("./QuickAssign", () => ({ AUTO_ASSIGN: [], QuickAssign: () => null }));
vi.mock("./LoanHeader", () => ({ CategoryLoans: () => null }));
afterEach(() => {
  cleanup();
  configureFormat({ currency: "SAR" });
});

const month = "2026-10";
const noop = () => {};
const rent: Category = { id: "rent", name: "Rent", group: "Bills", target: 20000, goal: { goal_type: "NEED", goal_cadence: 1 } };
const unfunded: CategorySummary = {
  id: "rent", assigned: 0, activity: 0, available: 0, carried: 0, needed: 20000,
  targetFundingRequired: 20000, targetFundingFunded: 0, monthTarget: 20000, targetDue: { date: "2026-10-31", monthly: true },
};
const sentence = (c: Category, s: CategorySummary) => {
  const text = targetText(c, s, categoryState(c, s, month));
  return text && targetSentence(text);
};

describe("deadline wording", () => {
  it("writes days as ordinals and dates in the budget's order", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31, 101, 111].map(ordinal)).toEqual(
      ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st", "101st", "111th"]);
    expect(deadline("2026-10-01")).toBe("1 October");
    configureFormat({ currency: "SAR", dateFormat: "mdy" });
    expect(deadline("2026-10-01")).toBe("October 1st");
  });

  it("says when a monthly target's money is due, and 'more' once some is there", () => {
    expect(sentence(rent, unfunded)).toBe(`${money(20000)} needed by the 31st`);
    expect(sentence(rent, { ...unfunded, assigned: 5000, available: 5000, needed: 15000, targetFundingFunded: 5000 }))
      .toBe(`${money(15000)} more needed by the 31st`);
    expect(sentence(rent, { ...unfunded, targetDue: { date: "2026-10-15", monthly: true } })).toBe(`${money(20000)} needed by the 15th`);
  });

  it("names a dated target's day in its month and spreads it over the months before", () => {
    const annual = { ...rent, goal: { goal_type: "NEED", goal_cadence: 13, goal_target_date: "2025-10-01" } };
    const due = { ...unfunded, assigned: 1000, available: 1000, needed: 19000, targetFundingFunded: 1000, targetDue: { date: "2026-10-01", monthly: false } };
    expect(sentence(annual, due)).toBe(`${money(19000)} more needed by 1 October`);
    configureFormat({ currency: "SAR", dateFormat: "mdy" });
    expect(sentence(annual, due)).toBe(`${money(19000)} more needed by October 1st`);
    // Due in a later month (or weekly, or a savings builder): Rust sends no single deadline.
    expect(sentence(annual, { ...due, targetDue: undefined })).toBe(`${money(19000)} more needed this month`);
    expect(sentence(annual, { ...unfunded, targetDue: undefined })).toBe(`${money(20000)} needed this month`);
  });

  it("says Funded or Fully spent once the month's target is met", () => {
    const met = { ...unfunded, assigned: 20000, needed: 0, targetFundingFunded: 20000 };
    expect(sentence(rent, { ...met, available: 20000 })).toBe("Funded");
    expect(sentence(rent, { ...met, available: 5000, activity: -15000 })).toBe("Funded");
    expect(sentence(rent, { ...met, available: 0, activity: -20000 })).toBe("Fully spent");
    // Nothing to say without a target, or with nothing assigned or spent yet.
    expect(sentence({ ...rent, target: 0, goal: null }, { ...met, available: 0, activity: -20000 })).toBeNull();
    expect(sentence(rent, { ...unfunded, needed: 0, targetFundingRequired: 0, monthTarget: 0 })).toBeNull();
  });

  it("leaves overspending its own words, and a snoozed target's schedules no deadline", () => {
    expect(sentence(rent, { ...unfunded, available: -500, activity: -500, needed: 20500 })).toBeNull();
    const snoozed = { ...rent, goal: { ...rent.goal, goal_snoozed_at: `${month}-01` } };
    expect(sentence(snoozed, { ...unfunded, available: 1000, assigned: 1000, upcoming: 4000, needed: 3000 })).toBe(`${money(3000)} more needed this month`);
  });
});

function renderRow(c: Category, s: CategorySummary) {
  return render(
    <CategoryRow category={c} summary={s} month={month} selected={false} renaming={false} drop={null} dragging={false} dnd={null}
      onSelect={noop} onAssign={noop} onRename={noop} onStartRename={noop} onMenu={noop} onMoveMoney={noop} onActivity={noop}
      moveCount={0} movedMoney={false} onMoves={noop} onStep={noop} />,
  );
}

describe("rows", () => {
  it("show what's needed with its deadline", () => {
    const { container } = renderRow(rent, unfunded);
    expect(container.textContent).toContain(`${money(20000)} needed by the 31st`);
    expect(screen.getByRole("button", { name: /available in Rent/ }).getAttribute("aria-label")).toBe(
      `${money(0)} available in Rent, ${money(20000)} needed by the 31st. Move funds`);
  });

  it("show a met target's state", () => {
    const { container } = renderRow(rent, { ...unfunded, assigned: 20000, activity: -20000, needed: 0, targetFundingFunded: 20000 });
    expect(container.textContent).toContain("Fully spent");
    expect(container.textContent).not.toMatch(/needed/);
  });
});

function inspector(budget: Budget, rows: CategorySummary[], selected: Category[] = [], edit: (fn: (b: Budget) => void) => void = noop) {
  const summary: Summary = { assigned: 0, available: 0, activity: 0, income: 0, netWorth: 0, readyToAssign: 0, accounts: [], categories: rows };
  return (
    <BudgetInspector budget={budget} summary={summary} summaries={new Map(rows.map((s) => [s.id, s]))}
      month={month} currentMonth={month} selected={selected} visibleIds={budget.categories.map((c) => c.id)}
      onAutoAssign={noop} onEditCategory={noop} onClear={noop} edit={edit} targetOpen={false} onTargetOpen={noop} onSaved={noop} />
  );
}

describe("selected category", () => {
  it("says what's needed and by when instead of a bare Still needed", () => {
    const { container } = render(inspector({ ...demoBudget(), categories: [rent] }, [unfunded], [rent]));
    expect(container.querySelector(".target-status.short")?.textContent).toBe(`${money(20000)} needed by the 31st`);
    expect(screen.queryByText("Still needed")).toBeNull();
  });

  it("says Funded once the month's target is met", () => {
    render(inspector({ ...demoBudget(), categories: [rent] }, [{ ...unfunded, assigned: 20000, available: 20000, needed: 0, targetFundingFunded: 20000 }], [rent]));
    expect(screen.getByText("Funded").closest(".target-status")?.classList.contains("short")).toBe(false);
  });
});

describe("a balance with no date", () => {
  // The imported Emergency fund: 15,000.00 to have eventually and 13,000.00 saved. YNAB's row
  // says "2,000.00 more needed eventually", and its underfunded amount is 0 (Rust's needed).
  const fund: Category = { id: "fund", name: "Emergency fund", group: "Needs", target: 1500000, goal: { goal_type: "TB" } };
  const saved: CategorySummary = {
    id: "fund", assigned: 0, activity: 0, available: 1300000, carried: 1300000, needed: 0,
    targetFundingRequired: 1500000, targetFundingFunded: 1300000, monthTarget: 0,
  };

  it("says what's still needed eventually, without asking for it this month", () => {
    expect(categoryState(fund, saved, month)).toMatchObject({ status: "positive", needed: 0, eventually: 200000 });
    expect(sentence(fund, saved)).toBe(`${money(200000)} more needed eventually`);
    expect(sentence(fund, { ...saved, available: 0, carried: 0, targetFundingFunded: 0 })).toBe(`${money(1500000)} needed eventually`);
    expect(sentence(fund, { ...saved, available: 1500000, targetFundingFunded: 1500000 })).toBe("Funded");
    // A bill it can't cover is still needed this month.
    expect(sentence(fund, { ...saved, upcoming: 1400000, needed: 100000 })).toBe(`${money(100000)} more needed this month`);
    expect(sentence({ ...fund, goal: { goal_type: "TB", goal_snoozed_at: `${month}-01` } }, saved)).toBeNull();
  });

  it("shows it on the row with a positive Available", () => {
    const { container } = renderRow(fund, saved);
    expect(container.textContent).toContain(`${money(200000)} more needed eventually`);
    expect(container.querySelector("button.available")?.classList.contains("positive")).toBe(true);
  });

  it("shows it in the details as a note, not a warning or Still needed", () => {
    const { container } = render(inspector({ ...demoBudget(), categories: [fund] }, [saved], [fund]));
    const status = container.querySelector(".target-status");
    expect(status?.textContent).toBe(`${money(200000)} more needed eventually`);
    expect(status?.classList.contains("later")).toBe(true);
    expect(status?.classList.contains("short")).toBe(false);
    expect(screen.queryByText("Still needed")).toBeNull();
  });
});

describe("the month's targets and expected income", () => {
  const car: Category = { id: "car", name: "Car", group: "Goals", target: 120000, goal: { goal_type: "NEED", goal_cadence: 13, goal_target_date: "2027-09-30" } };
  const hidden: Category = { ...rent, id: "old", name: "Old", hidden: true };
  const savings: Category = { id: "savings", name: "Savings", group: "Goals", target: 500000, goal: { goal_type: "TB" } };
  const rows: CategorySummary[] = [
    unfunded,
    { ...unfunded, id: "car", monthTarget: 10000, targetDue: undefined },
    { ...unfunded, id: "old", monthTarget: 9900 },
    { ...unfunded, id: "savings", monthTarget: 0, targetDue: undefined },
  ];
  const start = (expectedIncome?: number) => {
    let budget: Budget = { ...demoBudget(), categories: [rent, car, hidden, savings], expectedIncome };
    const edit = vi.fn((fn: (b: Budget) => void) => {
      budget = structuredClone(budget);
      fn(budget);
      view.rerender(inspector(budget, rows, [], edit));
    });
    const view = render(inspector(budget, rows, [], edit));
    return { edit, current: () => budget, status: () => view.container.querySelector(".month-cost .target-status") };
  };
  const line = (label: string) => screen.getByText(label).closest("div")?.textContent;

  it("totals each visible target's amount for the month from the summary", () => {
    start();
    expect(screen.getByRole("heading", { name: "Targets and income" })).toBeTruthy();
    expect(line("October's targets")).toBe(`October's targets${money(30000)}`);
  });

  it("starts empty after an import and saves the income with the budget", () => {
    const { edit, current, status } = start();
    const income = screen.getByLabelText("Expected income") as HTMLInputElement;
    expect(income.value).toBe("");
    expect(screen.getByText(/The income you expect each month/)).toBeTruthy();
    fireEvent.focus(income);
    fireEvent.change(income, { target: { value: "250" } });
    fireEvent.blur(income);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(current().expectedIncome).toBe(25000);
    expect(income.value).toBe(`${money(25000)}`);
    expect(status()?.textContent).toBe(`Targets are ${money(5000)} more than expected income`);
    expect(status()?.classList.contains("short")).toBe(true);
  });

  it("shows what's left when income covers the targets, and clearing removes it", () => {
    const { edit, current, status } = start(7_291_710);
    expect(status()?.textContent).toBe(`${money(7261710)} left after targets`);
    expect(status()?.classList.contains("short")).toBe(false);
    const income = screen.getByLabelText("Expected income") as HTMLInputElement;
    expect(income.value).toBe(`${money(7291710)}`);
    fireEvent.focus(income);
    fireEvent.change(income, { target: { value: "" } });
    fireEvent.blur(income);
    expect(current()).not.toHaveProperty("expectedIncome");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(status()).toBeNull();
  });

  it("rejects a negative income without saving it", () => {
    const { edit } = start();
    const income = screen.getByLabelText("Expected income");
    fireEvent.focus(income);
    fireEvent.change(income, { target: { value: "-5" } });
    fireEvent.blur(income);
    expect(edit).not.toHaveBeenCalled();
    expect(income.getAttribute("aria-invalid")).toBe("true");
  });
});
