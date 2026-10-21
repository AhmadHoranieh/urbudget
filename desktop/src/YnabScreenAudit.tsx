import { money, monthName } from "./format";
import type { Budget, YnabScreenDifference } from "./types";

// Enough to see a pattern without filling the panel.
const LIMIT = 20;
const amount = (n: number | null) => (n === null ? "none" : money(n));
const days = (n: number | null) => (n === null ? "none" : `${n} ${n === 1 ? "day" : "days"}`);

/**
 * How an imported budget compares with what YNAB's own screens showed: Ready to Assign with
 * later months' assignments held back, age of money, and what each category is short. Unlike
 * the API checks, these can differ without stopping an import. Imports made before these
 * checks existed show nothing.
 */
export function YnabScreenAudit({ audit }: { audit: NonNullable<Budget["importAudit"]> }) {
  const { shownReadyToAssignDifferences: ready, ageOfMoneyDifferences: age, underfundedDifferences: under } = audit;
  if (!ready || !age || !under) return null;
  const kinds = [
    { label: "Ready to Assign", what: "Ready to Assign", unit: "month", rows: ready, show: amount },
    { label: "Age of money", what: "age of money", unit: "month", rows: age, show: days },
    { label: "Underfunded", what: "underfunded amounts", unit: "category month", rows: under, show: amount },
  ].filter((k) => k.rows.length > 0);
  if (kinds.length === 0)
    return <p>Ready to Assign, age of money and underfunded amounts match what YNAB's screens show in every month.</p>;
  const counts = kinds.map((k) => `${k.what} in ${k.rows.length} ${k.unit}${k.rows.length === 1 ? "" : "s"}`);
  return (
    <>
      <p>
        Compared with what YNAB's screens show, these differ:{" "}
        {counts.length > 1 ? `${counts.slice(0, -1).join(", ")} and ${counts[counts.length - 1]}` : counts[0]}.
      </p>
      <details>
        <summary>Show differences</summary>
        <ul>
          {kinds.flatMap((k) => {
            const rows = [...k.rows].sort((a, b) => a.month.localeCompare(b.month));
            const items = rows.slice(0, LIMIT).map((d: YnabScreenDifference, i) => (
              <li key={`${k.label}-${i}`}>
                {k.label}, {d.category ? `${d.category}, ` : ""}
                {monthName(d.month)}: {k.show(d.actual)} here, {k.show(d.expected)} in YNAB
              </li>
            ));
            if (rows.length > LIMIT)
              items.push(
                <li key={`${k.label}-more`}>
                  …and {rows.length - LIMIT} more for {k.what}
                </li>,
              );
            return items;
          })}
        </ul>
      </details>
    </>
  );
}
