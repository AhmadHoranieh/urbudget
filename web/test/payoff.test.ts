// The /tools/ payoff calculators (public/assets/payoff.js). Expected numbers come from outside
// the code: arithmetic done by hand, the app's own loan planner example, and the standard loan
// payment formula, not from running the same functions again.

import { describe, expect, it } from "vitest";
import {
  MAX_MONTHS,
  calculate,
  monthlyInterest,
  parseMoney,
  parseMonth,
  parseRate,
  paymentFor,
  project,
  projectMinimum,
  scheduleCsv,
} from "../public/assets/payoff.js";

const NOV_2026 = 2026 * 12 + 10;

describe("monthly interest", () => {
  it("is balance × APR ÷ 12, to the nearest cent, half up", () => {
    expect(monthlyInterest(500000, 22000)).toBe(9167); // $5,000 at 22%: $91.666…
    expect(monthlyInterest(900000, 4900)).toBe(3675); // $9,000 at 4.9%: $36.75
    expect(monthlyInterest(100, 6000)).toBe(1); // $1 at 6%: half a cent rounds up
    expect(monthlyInterest(123456, 0)).toBe(0);
  });
});

describe("fixed payments", () => {
  it("matches the app's loan planner: $9,000 at 4.9%, $750 a month, $150 extra", () => {
    const base = project({ balance: 900000, rate: 4900, payment: 75000 });
    const boosted = project({ balance: 900000, rate: 4900, payment: 75000, extra: 15000 });
    expect(base.months).toBe(13);
    expect(boosted.months).toBe(11);
    expect(base.totalInterest - boosted.totalInterest).toBe(3917);
  });

  it("finds the standard loan payment: $10,000 at 6% over 36 months is $304.22", () => {
    expect(paymentFor({ balance: 1000000, rate: 6000, months: 36 })).toBe(30422);
    expect(project({ balance: 1000000, rate: 6000, payment: 30421 }).months).toBe(37);
  });

  it("splits a 0% balance evenly", () => {
    expect(paymentFor({ balance: 100000, rate: 0, months: 10 })).toBe(10000);
    const run = project({ balance: 100000, rate: 0, payment: 10000 });
    expect(run).toMatchObject({ months: 10, totalInterest: 0, totalPaid: 100000 });
  });

  it("caps the last payment at what's owed", () => {
    const run = project({ balance: 10000, rate: 0, payment: 4000 });
    expect(run.schedule.map((r) => r.payment)).toEqual([4000, 4000, 2000]);
  });

  it("refuses a payment that only covers the interest, or less", () => {
    // $1,000 at 12% charges $10.00 in the first month.
    expect(project({ balance: 100000, rate: 12000, payment: 1000 })).toEqual({ error: "too-small", charge: 1000 });
    expect(project({ balance: 100000, rate: 12000, payment: 999 }).error).toBe("too-small");
    // One cent over the interest does pay it off: the loan formula, n = −ln(1 − rP/A) / ln(1 + r),
    // gives about 694 months for $1,000 at 1% a month paying $10.01.
    const slow = project({ balance: 100000, rate: 12000, payment: 1001 });
    expect(slow.months).toBeGreaterThan(680);
    expect(slow.months).toBeLessThan(710);
    // $12,000 at 1.2% paying $12.01 needs about 7,090 months, past the 100-year limit.
    expect(project({ balance: 1200000, rate: 1200, payment: 1201 }).error).toBe("too-long");
  });

  it("has nothing to pay on a zero balance", () => {
    expect(project({ balance: 0, rate: 22000, payment: 5000 })).toMatchObject({ months: 0, totalPaid: 0 });
  });
});

describe("one-time lump sums", () => {
  it("adds a lump to that month's payment", () => {
    // $1,000 at 0%, $100 a month, $300 more with the third payment: 900, 800, 400, 300, 200, 100, 0.
    const run = project({ balance: 100000, rate: 0, payment: 10000, lumps: [{ month: 2, amount: 30000 }] });
    expect(run.schedule.map((r) => r.payment)).toEqual([10000, 10000, 40000, 10000, 10000, 10000, 10000]);
    expect(run).toMatchObject({ months: 7, totalPaid: 100000, totalInterest: 0 });
  });

  it("charges that month's interest first, then the next month's on the lower balance", () => {
    // $10,000 at 12% (1% a month), $500 a month, $1,000 lump with the first payment:
    // month 1: $100.00 interest, $1,500 paid, $1,400 principal, $8,600 left;
    // month 2: $86.00 interest, $414 principal, $8,186 left.
    const early = project({ balance: 1000000, rate: 12000, payment: 50000, lumps: [{ month: 0, amount: 100000 }] });
    expect(early.schedule.slice(0, 2)).toEqual([
      { payment: 150000, interest: 10000, fees: 0, principal: 140000, balance: 860000 },
      { payment: 50000, interest: 8600, fees: 0, principal: 41400, balance: 818600 },
    ]);
    // The same lump a month later: month 1 leaves $9,600; month 2 charges $96.00, pays $1,500, leaves $8,196.
    const late = project({ balance: 1000000, rate: 12000, payment: 50000, lumps: [{ month: 1, amount: 100000 }] });
    expect(late.schedule[1]).toEqual({ payment: 150000, interest: 9600, fees: 0, principal: 140400, balance: 819600 });
    // A month earlier saves one month's interest on the $1,000: $10.
    expect(late.schedule[1].balance - early.schedule[1].balance).toBe(1000);
  });

  it("never pays more than is owed, and skips a lump after the payoff month", () => {
    const big = project({ balance: 50000, rate: 0, payment: 10000, lumps: [{ month: 1, amount: 100000 }] });
    expect(big.schedule.map((r) => r.payment)).toEqual([10000, 40000]);
    const late = project({ balance: 30000, rate: 0, payment: 10000, lumps: [{ month: 5, amount: 50000 }] });
    expect(late).toMatchObject({ months: 3, totalPaid: 30000 });
    const out = calculate({ balance: 30000, rate: 0, payment: 10000, lumps: [{ month: 5, amount: 50000 }] }, NOV_2026);
    expect(out.html).toContain("It's paid off before April 2027, so the lump sum isn't needed.");
  });

  it("adds up lumps in the same month", () => {
    const run = project({ balance: 100000, rate: 0, payment: 10000, lumps: [{ month: 0, amount: 10000 }, { month: 0, amount: 20000 }] });
    expect(run.schedule[0].payment).toBe(40000);
  });

  it("doesn't let a lump hide a payment that never covers the interest", () => {
    // $1,000 at 12% charges $10.00; a $10 payment never brings it down, whatever comes in month 4.
    expect(project({ balance: 100000, rate: 12000, payment: 1000, lumps: [{ month: 3, amount: 50000 }] }).error).toBe("too-small");
  });

  it("describes the plan with the lump sum", () => {
    // $1,000 at 0%, $100 a month, $200 extra in the third month (January 2027): 8 payments instead of 10.
    const out = calculate({ balance: 100000, rate: 0, payment: 10000, lumps: [{ month: 2, amount: 20000 }] }, NOV_2026);
    expect(out.html).toContain("With a $200 lump sum in January 2027");
    expect(out.html).toContain("The $200 lump sum pays it off <b>2 months sooner</b>. At 0% there's no interest to save.");
    expect(out.caption).toBe("Payment schedule with your extra payments (8 payments)");
    const both = calculate({ balance: 100000, rate: 0, payment: 10000, extra: 5000, lumps: [{ month: 2, amount: 20000 }] }, NOV_2026);
    expect(both.html).toContain("With $50 extra a month and a $200 lump sum in January 2027");
  });
});

describe("paying only the minimum", () => {
  it("takes the percent of the new balance, plus interest, as the first minimum", () => {
    // $5,000 at 22%: $91.67 interest; 1% of $5,091.67 is $50.92; $50.92 + $91.67 = $142.59.
    const run = projectMinimum({ balance: 500000, rate: 22000, percent: 1000, floor: 4000 });
    expect(run.first).toBe(14259);
    expect(run.schedule[0]).toEqual({ payment: 14259, interest: 9167, fees: 0, principal: 5092, balance: 494908 });
  });

  it("pays the floor while it's more than the percent, month by month", () => {
    // $1,000 at 12%, 1% plus interest, at least $25.
    // Month 1: $10.00 interest; $10.10 + $10.00 = $20.10, so $25 is due; $985.00 left.
    // Month 2: $9.85 interest; 1% of $994.85 is $9.95; $19.80, so $25 again; $969.85 left.
    const run = projectMinimum({ balance: 100000, rate: 12000, percent: 1000, floor: 2500 });
    expect(run.schedule[0]).toMatchObject({ payment: 2500, interest: 1000, balance: 98500 });
    expect(run.schedule[1]).toMatchObject({ payment: 2500, interest: 985, balance: 96985 });
  });

  it("makes the last payment only what's left", () => {
    const run = projectMinimum({ balance: 10000, rate: 0, percent: 1000, floor: 4000 });
    expect(run.schedule.map((r) => r.payment)).toEqual([4000, 4000, 2000]);
    const odd = projectMinimum({ balance: 101000, rate: 0, percent: 1000, floor: 4000 });
    expect(odd.months).toBe(26); // 25 × $40, then $10
    expect(odd.schedule.at(-1)?.payment).toBe(1000);
  });

  it("moves from the percent to the floor as the balance falls", () => {
    // $8,000 at 0%, 1% of the balance with no interest added, at least $40: the percent is due
    // until the balance drops under $4,000, then $40 a month, and every dollar is principal.
    const run = projectMinimum({ balance: 800000, rate: 0, percent: 1000, floor: 4000, plusInterest: false });
    if (run.error) throw new Error(run.error);
    const pay = run.schedule.map((r) => r.payment);
    expect(pay[0]).toBe(8000);
    expect(run.totalPaid).toBe(800000);
    expect(run.totalInterest).toBe(0);
    for (let i = 1; i < pay.length; i++) expect(pay[i]).toBeLessThanOrEqual(pay[i - 1]);
    const firstFloor = pay.indexOf(4000);
    expect(firstFloor).toBeGreaterThan(0);
    expect(run.schedule[firstFloor - 1].balance).toBeLessThan(400000 + 50); // the percent rounded down to $40
    expect(pay.slice(firstFloor, -1).every((p) => p === 4000)).toBe(true);
    expect(pay.at(-1)).toBeLessThanOrEqual(4000);
  });

  it("adds fees to the new balance and the minimum, without counting them as interest", () => {
    // $500 at 0% with a $5 monthly fee: the new balance is $505; $5.05 + $5 = $10.05, so $25 is due,
    // of which $20 is principal.
    const run = projectMinimum({ balance: 50000, rate: 0, percent: 1000, floor: 2500, fees: 500 });
    if (run.error) throw new Error(run.error);
    expect(run.schedule[0]).toEqual({ payment: 2500, interest: 0, fees: 500, principal: 2000, balance: 48000 });
    expect(run.totalInterest).toBe(0);
    expect(run.totalFees).toBe(500 * run.months);
    expect(run.totalPaid).toBe(50000 + run.totalFees);
  });

  it("says when the minimum never brings the balance down", () => {
    // $5,000 at 24% charges $100; 1% of $5,100 is $51, less than the interest.
    expect(projectMinimum({ balance: 500000, rate: 24000, percent: 1000, plusInterest: false })).toEqual({
      error: "too-small",
      charge: 10000,
      payment: 5100,
    });
    // A minimum of exactly the interest leaves the balance where it is.
    expect(projectMinimum({ balance: 100000, rate: 12000, percent: 0 }).error).toBe("too-small");
  });

  it("stops at 100 years instead of running forever", () => {
    // 1% of $1,000,000 a month, at least one cent: the balance shrinks by about 1% a month.
    const run = projectMinimum({ balance: 100000000, rate: 0, percent: 1000, floor: 1, plusInterest: false });
    expect(run).toEqual({ error: "too-long" });
    expect(MAX_MONTHS).toBe(1200);
  });

  it("has nothing to pay on a zero balance", () => {
    expect(projectMinimum({ balance: 0, rate: 22000, percent: 1000, floor: 4000 })).toMatchObject({ months: 0, first: 0 });
  });
});

describe("results and the schedule file", () => {
  it("compares paying only the minimum with a fixed payment", () => {
    const out = calculate({ balance: 500000, rate: 22000, payment: 15000 }, NOV_2026, "", {
      percent: 1000,
      floor: 4000,
      plusInterest: true,
    });
    expect(out.html).toContain("Paying only the minimum <span>(first minimum $142.59)</span>");
    expect(out.html).toContain("Paying $150 a month instead of only the minimum");
  });

  it("writes the schedule the table shows as CSV", () => {
    // $9,000 at 4.9%, $750: $36.75 interest, $713.25 principal, $8,286.75 left in November 2026.
    const run = project({ balance: 900000, rate: 4900, payment: 75000 });
    if (run.error) throw new Error(run.error);
    const lines = scheduleCsv(run, NOV_2026).trim().split("\r\n");
    expect(lines[0]).toBe("Month,Payment,Interest,Principal,Balance");
    expect(lines[1]).toBe("2026-11,750.00,36.75,713.25,8286.75");
    expect(lines).toHaveLength(14);
    expect(lines.at(-1)?.endsWith(",0.00")).toBe(true);
  });

  it("adds a fees column only when there are fees", () => {
    const run = projectMinimum({ balance: 50000, rate: 0, percent: 1000, floor: 2500, fees: 500 });
    if (run.error) throw new Error(run.error);
    const [head, first] = scheduleCsv(run, NOV_2026).split("\r\n");
    expect(head).toBe("Month,Payment,Interest,Fees,Principal,Balance");
    expect(first).toBe("2026-11,25.00,0.00,5.00,20.00,480.00");
  });
});

describe("reading what people type", () => {
  it("reads amounts, rates and months", () => {
    expect(parseMoney("$9,000.50")).toBe(900050);
    expect(parseMoney(".5")).toBe(50);
    expect(parseMoney("12.345")).toBeNaN();
    expect(parseRate("4.9%")).toBe(4900);
    expect(parseRate("1,000")).toBeNaN();
    expect(parseMonth("2026-11")).toBe(NOV_2026);
    expect(parseMonth("11/2026")).toBe(NOV_2026);
    expect(parseMonth("Nov 2026")).toBe(NOV_2026);
    expect(parseMonth("13/2026")).toBeNaN();
  });
});
