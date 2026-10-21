import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { YnabScreenAudit } from "./YnabScreenAudit";
import { money } from "./format";
import type { Budget } from "./types";

afterEach(cleanup);

const audit = (extra: object) =>
  ({
    accountChecks: 3,
    categoryMonthChecks: 12,
    monthChecks: 2,
    accountDifferences: [],
    categoryDifferences: [],
    readyToAssignDifferences: [],
    ...extra,
  }) as NonNullable<Budget["importAudit"]>;

it("lists each kind of difference from YNAB's screens", () => {
  const { container } = render(
    <YnabScreenAudit
      audit={audit({
        shownReadyToAssignDifferences: [{ month: "2025-03", expected: 0, actual: 7100 }],
        ageOfMoneyDifferences: [
          { month: "2025-02", expected: 128, actual: 127 },
          { month: "2024-10", expected: 6, actual: null },
        ],
        underfundedDifferences: [{ month: "2025-02", category: "Budget Margin", expected: 100000, actual: 200000 }],
      })}
    />,
  );
  expect(container.querySelector("p")?.textContent).toBe(
    "Compared with what YNAB's screens show, these differ: Ready to Assign in 1 month, age of money in 2 months and underfunded amounts in 1 category month.",
  );
  expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    `Ready to Assign, March 2025: ${money(7100)} here, ${money(0)} in YNAB`,
    "Age of money, October 2024: none here, 6 days in YNAB",
    "Age of money, February 2025: 127 days here, 128 days in YNAB",
    `Underfunded, Budget Margin, February 2025: ${money(200000)} here, ${money(100000)} in YNAB`,
  ]);
});

it("says when everything matches, and shows nothing for imports made before these checks", () => {
  render(
    <YnabScreenAudit
      audit={audit({ shownReadyToAssignDifferences: [], ageOfMoneyDifferences: [], underfundedDifferences: [] })}
    />,
  );
  expect(screen.getByText(/match what YNAB's screens show in every month/)).toBeTruthy();
  cleanup();
  const { container } = render(<YnabScreenAudit audit={audit({})} />);
  expect(container.textContent).toBe("");
});
