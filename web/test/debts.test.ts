// The debt snowball and avalanche calculator (public/assets/debts.js). Expected numbers come from
// outside the code: months worked out by hand in the comments, and the loan payment formula,
// not from running the same functions again.

import { describe, expect, it } from "vitest";
import { MAX_DEBTS, calculate, compare, minimumsOnly, plan, priority, scheduleCsv } from "../public/assets/debts.js";

const NOV_2026 = 2026 * 12 + 10;
const debt = (balance: number, rate: number, minimum: number, name = "Debt") => ({ name, balance, rate, minimum });
const payments = (run: { schedule: { payments: number[] }[] }) => run.schedule.map((m) => m.payments);
const balances = (run: { schedule: { balances: number[] }[] }) => run.schedule.map((m) => m.balances);

// The page's example: amounts in cents, rates in thousandths of a percent.
const EXAMPLE = [
  debt(680000, 24000, 20400, "Visa"),
  debt(240000, 12000, 11000, "Personal loan"),
  debt(980000, 6000, 29500, "Car loan"),
];

describe("a plan at 0%, month by month", () => {
  // A: $100, minimum $20. B: $300, minimum $30. $100 a month, snowball (A is smaller).
  // Month 1: minimums $20 + $30; the other $50 goes to A, which pays $70 and owes $30. B owes $270.
  // Month 2: A's minimum $20, $30 to B, $50 left; A needs $10 more and is paid off with $30.
  //          The other $40 goes to B, which pays $70 and owes $200.
  // Month 3: A is gone, so its $20 stays in the plan: B gets all $100 and owes $100.
  // Month 4: B gets $100 and is paid off.
  const debts = [debt(10000, 0, 2000, "A"), debt(30000, 0, 3000, "B")];
  const run = plan({ debts, monthly: 10000, strategy: "snowball" });
  if (run.error) throw new Error(run.error);

  it("pays the target, then rolls everything onto the next debt", () => {
    expect(payments(run)).toEqual([
      [7000, 3000],
      [3000, 7000],
      [0, 10000],
      [0, 10000],
    ]);
    expect(balances(run)).toEqual([
      [3000, 27000],
      [0, 20000],
      [0, 10000],
      [0, 0],
    ]);
  });

  it("reports the payoff months, the order and the totals", () => {
    expect(run.months).toBe(4);
    expect(run.priority).toEqual([0, 1]);
    expect(run.order).toEqual([0, 1]);
    expect(run.debts).toEqual([
      { month: 2, interest: 0, paid: 10000 },
      { month: 4, interest: 0, paid: 30000 },
    ]);
    expect(run).toMatchObject({ totalInterest: 0, totalPaid: 40000 });
  });

  it("puts a one-time extra on the target in the first month only", () => {
    // $150 extra: $200 is left after the minimums. A needs $80 more and is paid off with $100;
    // the other $120 goes to B, which pays $150 and owes $150. Then $100, then the last $50.
    const boosted = plan({ debts, monthly: 10000, extra: 15000, strategy: "snowball" });
    if (boosted.error) throw new Error(boosted.error);
    expect(payments(boosted)).toEqual([
      [10000, 15000],
      [0, 10000],
      [0, 5000],
    ]);
  });

  it("compares with paying only the minimums: $20 a month for 5 months, $30 for 10", () => {
    const least = minimumsOnly(debts);
    if (least.error) throw new Error(least.error);
    expect(least.months).toBe(10);
    expect(least.debts.map((d: { month: number }) => d.month)).toEqual([5, 10]);
    expect(least.first).toBe(5000);
    expect(payments(least).at(-1)).toEqual([0, 3000]); // A's $20 is no longer paid at all
    expect(least.totalPaid).toBe(40000);
  });
});

describe("a plan with interest", () => {
  it("charges each month's interest before paying: two months by hand", () => {
    // Card: $1,000 at 24% (2% a month), minimum $50. Loan: $2,000 at 6% (0.5% a month), minimum $100.
    // $300 a month, avalanche: the card first.
    // Month 1: interest $20.00 and $10.00. Minimums $150; the other $150 goes to the card, so it
    //          gets $200: $1,020 − $200 = $820.00. The loan: $2,010 − $100 = $1,910.00.
    // Month 2: interest $820 × 2% = $16.40 and $1,910 × 0.5% = $9.55.
    //          The card: $836.40 − $200 = $636.40. The loan: $1,919.55 − $100 = $1,819.55.
    const run = plan({ debts: [debt(100000, 24000, 5000), debt(200000, 6000, 10000)], monthly: 30000, strategy: "avalanche" });
    if (run.error) throw new Error(run.error);
    expect(run.schedule[0]).toEqual({ payments: [20000, 10000], interest: [2000, 1000], balances: [82000, 191000] });
    expect(run.schedule[1]).toEqual({ payments: [20000, 10000], interest: [1640, 955], balances: [63640, 181955] });
  });

  it("rounds each month's interest to the cent", () => {
    // $1,234.56 at 19.99%: 1,234.56 × 0.1999 ÷ 12 = 20.5657…, so $20.57.
    const run = plan({ debts: [debt(123456, 19990, 5000)], monthly: 5000 });
    if (run.error) throw new Error(run.error);
    expect(run.schedule[0].interest).toEqual([2057]);
    expect(run.schedule[0].balances).toEqual([123456 + 2057 - 5000]);
    // Every cent paid is either the balance or interest.
    expect(run.totalPaid).toBe(123456 + run.totalInterest);
  });

  it("makes the final payment on each debt only what's left, and passes the rest on", () => {
    // A: $90 at 0%, minimum $30. B: $200 at 12% (1% a month), minimum $50. $100 a month, snowball.
    // Month 1: B's interest $2.00. A gets $30 + $20 = $50 and owes $40; B pays $50: $202 − $50 = $152.00.
    // Month 2: B's interest $1.52. A needs only $40 (its last payment), so $10 more goes to B:
    //          B pays $60: $153.52 − $60 = $93.52.
    // Month 3: B's interest $0.9352, so $0.94; B owes $94.46 and that's its last payment.
    const run = plan({ debts: [debt(9000, 0, 3000), debt(20000, 12000, 5000)], monthly: 10000, strategy: "snowball" });
    if (run.error) throw new Error(run.error);
    expect(payments(run)).toEqual([
      [5000, 5000],
      [4000, 6000],
      [0, 9446],
    ]);
    expect(balances(run)).toEqual([
      [4000, 15200],
      [0, 9352],
      [0, 0],
    ]);
    expect(run.totalInterest).toBe(200 + 152 + 94);
    expect(run.totalPaid).toBe(29446);
    expect(run.debts.map((d: { month: number }) => d.month)).toEqual([2, 3]);
  });
});

describe("snowball and avalanche", () => {
  // Visa $6,800 at 24%, minimum $204; personal loan $2,400 at 12%, minimum $110;
  // car loan $9,800 at 6%, minimum $295; $900 a month.
  // Month 1 interest: $136.00, $24.00 and $49.00. Minimums $609, so $291 is left.
  const runs = compare({ debts: EXAMPLE, monthly: 90000 });
  const { snowball, avalanche, minimums } = runs;
  if (snowball.error || avalanche.error || minimums.error) throw new Error("the example should run");

  it("put the extra on different debts", () => {
    expect(snowball.priority).toEqual([1, 0, 2]); // smallest balance first
    expect(avalanche.priority).toEqual([0, 1, 2]); // highest APR first
    expect(runs.same).toBe(false);
    // Snowball: the personal loan gets $110 + $291 = $401: $2,424 − $401 = $2,023.00.
    expect(snowball.schedule[0].balances).toEqual([673200, 202300, 955400]);
    // Avalanche: Visa gets $204 + $291 = $495: $6,936 − $495 = $6,441.00.
    expect(avalanche.schedule[0].balances).toEqual([644100, 231400, 955400]);
  });

  it("pay the debts off in different orders, and avalanche costs no more interest", () => {
    expect(snowball.order).toEqual([1, 0, 2]);
    expect(avalanche.order).toEqual([0, 1, 2]);
    expect(avalanche.totalInterest).toBeLessThanOrEqual(snowball.totalInterest);
    expect(avalanche.totalInterest).toBeLessThan(snowball.totalInterest);
  });

  it("pay off the first target when the loan formula says", () => {
    // n = −ln(1 − rP/A) / ln(1 + r), rounded up.
    const months = (balance: number, monthlyRate: number, payment: number) =>
      Math.ceil(-Math.log(1 - (monthlyRate * balance) / payment) / Math.log(1 + monthlyRate));
    expect(months(2400, 0.01, 401)).toBe(7); // snowball: the personal loan at $401 a month
    expect(snowball.debts[1].month).toBe(7);
    expect(months(6800, 0.02, 495)).toBe(17); // avalanche: Visa at $495 a month
    expect(avalanche.debts[0].month).toBe(17);
  });

  it("both beat paying only the minimums", () => {
    // Paying only the minimums, Visa's $204 against $136 of interest pays off $68 the first month.
    expect(minimums.schedule[0].balances).toEqual([680000 + 13600 - 20400, 240000 + 2400 - 11000, 980000 + 4900 - 29500]);
    expect(minimums.first).toBe(60900);
    for (const run of [snowball, avalanche]) {
      expect(run.months).toBeLessThan(minimums.months);
      expect(run.totalInterest).toBeLessThan(minimums.totalInterest);
    }
  });

  it("give the same order when the smallest balance also has the highest APR", () => {
    const debts = [debt(100000, 25000, 3000), debt(300000, 18000, 6000), debt(500000, 7000, 10000)];
    const same = compare({ debts, monthly: 30000 });
    expect(same.same).toBe(true);
    expect(same.snowball).toEqual(same.avalanche);
  });

  it("break ties: equal APRs by balance, equal balances by APR, then the order entered", () => {
    expect(priority([debt(500, 10000, 0), debt(300, 10000, 0)], "avalanche")).toEqual([1, 0]);
    expect(priority([debt(500, 10000, 0), debt(500, 20000, 0)], "snowball")).toEqual([1, 0]);
    expect(priority([debt(500, 10000, 0), debt(500, 10000, 0)], "snowball")).toEqual([0, 1]);
  });
});

describe("rolling over a paid-off minimum", () => {
  it("keeps a paid-off debt's minimum in the plan", () => {
    // A: $50, minimum $25. B: $500, minimum $25. $50 a month, exactly the minimums, all at 0%.
    // A is paid off by its own minimum in month 2; from month 3, B gets $25 + $25 = $50.
    // B owes $450 after month 2, so 9 more months: paid off in month 11.
    // Paying only the minimums, B takes $500 ÷ $25 = 20 months.
    const debts = [debt(5000, 0, 2500), debt(50000, 0, 2500)];
    const run = plan({ debts, monthly: 5000, strategy: "snowball" });
    const least = minimumsOnly(debts);
    if (run.error || least.error) throw new Error("should run");
    expect(payments(run).slice(0, 3)).toEqual([
      [2500, 2500],
      [2500, 2500],
      [0, 5000],
    ]);
    expect(run.months).toBe(11);
    expect(least.months).toBe(20);
    expect(payments(least)[2]).toEqual([0, 2500]);
  });

  it("reaches a debt that grows while it waits its turn", () => {
    // A: $500 at 0%, minimum $100. B: $1,000 at 30% (2.5% a month), minimum $10. $200 a month, snowball.
    // Month 1: B's interest $25.00 is more than its $10: $1,000 + $25 − $10 = $1,015.00. A owes $310.
    // Month 2: B's interest $25.375, so $25.38: $1,015 + $25.38 − $10 = $1,030.38. A owes $120.
    // Month 3: A's last $120; the other $70 goes to B, which pays $80.
    //          B's interest $1,030.38 × 2.5% = $25.7595, so $25.76: $1,056.14 − $80 = $976.14.
    const debts = [debt(50000, 0, 10000), debt(100000, 30000, 1000)];
    const run = plan({ debts, monthly: 20000, strategy: "snowball" });
    if (run.error) throw new Error(run.error);
    expect(balances(run).slice(0, 3)).toEqual([
      [31000, 101500],
      [12000, 103038],
      [0, 97614],
    ]);
    expect(payments(run)[2]).toEqual([12000, 8000]);
    expect(run.order).toEqual([0, 1]);
    // Paying only the minimums, B's $10 never covers its interest.
    expect(minimumsOnly(debts)).toEqual({ error: "never", month: 1, stuck: [{ index: 1, payment: 1000, interest: 2500 }] });
  });
});

describe("plans that can't work", () => {
  it("needs the monthly amount to cover the minimums", () => {
    // $204 + $110 + $295 = $609.
    expect(plan({ debts: EXAMPLE, monthly: 60899 })).toEqual({ error: "short", needed: 60900 });
    expect(plan({ debts: EXAMPLE, monthly: 60900 }).error).toBeUndefined();
    expect(calculate({ debts: EXAMPLE, monthly: 50000 }, NOV_2026)).toEqual({ error: { error: "short", needed: 60900 } });
  });

  it("finds a debt that never shrinks under the minimums", () => {
    // $5,000 at 24% charges $100.00 a month; a $100 minimum only pays the interest.
    const debts = [debt(500000, 24000, 10000, "Card"), debt(30000, 0, 3000, "Loan")];
    expect(minimumsOnly(debts)).toEqual({ error: "never", month: 1, stuck: [{ index: 0, payment: 10000, interest: 10000 }] });
    // With $150 a month, the card gets the loan's $30 minimum once the loan is paid off.
    const run = plan({ debts, monthly: 15000, strategy: "snowball" });
    expect(run.error).toBeUndefined();
  });

  it("names a debt the plan can never get ahead of", () => {
    // B: $10,000 at 24% charges $200 a month, all the $200 there is; A ($1,000 at 0%) still shrinks.
    const debts = [debt(100000, 0, 5000), debt(1000000, 24000, 15000)];
    expect(plan({ debts, monthly: 20000, strategy: "avalanche" })).toEqual({
      error: "never",
      month: 1,
      stuck: [{ index: 1, payment: 15000, interest: 20000 }],
    });
  });

  it("stops when no debt goes down", () => {
    // A: $10,000 at 24% ($200 interest), minimum $100. B: $10,000 at 12% ($100), minimum $50.
    // $250 a month, avalanche: A gets $100 + $100 = $200, B gets $50. Neither goes down, ever.
    const debts = [debt(1000000, 24000, 10000), debt(1000000, 12000, 5000)];
    expect(plan({ debts, monthly: 25000, strategy: "avalanche" })).toEqual({
      error: "never",
      month: 1,
      stuck: [
        { index: 0, payment: 20000, interest: 20000 },
        { index: 1, payment: 5000, interest: 10000 },
      ],
    });
  });

  it("stops at 100 years instead of running forever", () => {
    // $12,000 at 1.2% charges $12.00; $12.01 a month needs about 7,090 months by the loan formula.
    const debts = [debt(1200000, 1200, 1201)];
    expect(plan({ debts, monthly: 1201 })).toEqual({ error: "too-long" });
    expect(minimumsOnly(debts)).toEqual({ error: "too-long" });
  });

  it("refuses input it can't use", () => {
    expect(plan({ debts: [], monthly: 10000 })).toEqual({ error: "no-debts" });
    expect(plan({ debts: [debt(0, 0, 0)], monthly: 10000 })).toEqual({ error: "no-debts" });
    expect(plan({ debts: [debt(-1, 0, 0)], monthly: 10000 })).toMatchObject({ error: "bad-input", field: "balance", index: 0 });
    expect(plan({ debts: [debt(100, 0, 0), debt(100.5, 0, 0)], monthly: 10000 })).toMatchObject({ field: "balance", index: 1 });
    expect(plan({ debts: [debt(100, 1_000_001, 0)], monthly: 10000 })).toMatchObject({ field: "rate" });
    expect(plan({ debts: [debt(100, 0, Number.NaN)], monthly: 10000 })).toMatchObject({ field: "minimum" });
    expect(plan({ debts: [debt(100, 0, 0)], monthly: 10000, strategy: "biggest" })).toMatchObject({ field: "strategy" });
    expect(plan({ debts: [debt(100, 0, 0)], monthly: 10000, extra: -5 })).toMatchObject({ field: "extra" });
    expect(MAX_DEBTS).toBe(10);
  });
});

describe("a debt with no balance", () => {
  it("is already paid off, and its minimum goes to the plan from the first month", () => {
    // Old card: $0, minimum $40. Loan: $300 at 0%, minimum $30. $70 a month.
    // Only the loan's $30 has to be covered; it gets $70 a month: 4 × $70 = $280, then the last $20.
    const debts = [debt(0, 20000, 4000, "Old card"), debt(30000, 0, 3000, "Loan")];
    expect(plan({ debts, monthly: 2999 })).toEqual({ error: "short", needed: 3000 });
    const run = plan({ debts, monthly: 7000, strategy: "snowball" });
    if (run.error) throw new Error(run.error);
    expect(payments(run)).toEqual([
      [0, 7000],
      [0, 7000],
      [0, 7000],
      [0, 7000],
      [0, 2000],
    ]);
    expect(run.debts[0]).toEqual({ month: 0, interest: 0, paid: 0 });
    expect(run.priority).toEqual([1]);
    expect(run.order).toEqual([1]);
    const least = minimumsOnly(debts);
    expect(least).toMatchObject({ months: 10, first: 3000 });
  });
});

describe("results", () => {
  it("compares the two methods and paying only the minimums", () => {
    const out = calculate({ debts: EXAMPLE, monthly: 90000, strategy: "snowball" }, NOV_2026);
    expect(out.html).toContain("<h3>Snowball: smallest balance first <span>(your choice)</span></h3>");
    expect(out.html).toContain("<h3>Avalanche: highest APR first</h3>");
    expect(out.html).toContain("Paying only the minimums <span>($609.00 in the first month)</span>");
    expect(out.html).toContain("Payoff order with snowball");
    expect(out.html).toContain("in month 7; avalanche pays off its first, Visa, in month 17.");
    expect(out.caption).toMatch(/^Month-by-month schedule with snowball \(\d+ months\)$/);
  });

  it("escapes names and lists only the debts still owed each month", () => {
    const debts = [debt(10000, 0, 2000, "<A & B>"), debt(30000, 0, 3000, "B")];
    const out = calculate({ debts, monthly: 10000, strategy: "snowball" }, NOV_2026);
    expect(out.html).toContain("&lt;A &amp; B&gt;");
    expect(out.html).not.toContain("<A & B>");
    expect(out.schedule.match(/<tr>/g)).toHaveLength(1 + 2 + 2 + 1 + 1 + 1); // header; both, both; B alone twice; total
  });

  it("writes the schedule as CSV, one line per debt per month", () => {
    const debts = [debt(10000, 0, 2000, "Card, store"), debt(30000, 0, 3000, "B")];
    const run = plan({ debts, monthly: 10000, strategy: "snowball" });
    if (run.error) throw new Error(run.error);
    const lines = scheduleCsv(run, debts, NOV_2026).trim().split("\r\n");
    expect(lines[0]).toBe("Month,Debt,Payment,Interest,Balance");
    expect(lines[1]).toBe('2026-11,"Card, store",70.00,0.00,30.00');
    expect(lines[2]).toBe("2026-11,B,30.00,0.00,270.00");
    expect(lines.at(-1)).toBe("2027-02,B,100.00,0.00,0.00");
    expect(lines).toHaveLength(1 + 6);
  });
});
