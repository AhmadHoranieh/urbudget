import { useRef } from "react";
import { formatDate, money, tone } from "./format";
import { useVirtualRows } from "./ui";

export type ActivityLine = {
  key: string;
  date: string;
  payee: string;
  account: string;
  memo: string;
  amount: number;
  category?: string;
};
/** Each line is this tall, so long lists render only the lines in view. */
const LINE = 44;

/**
 * Transactions as compact lines: date, payee over account and memo, an optional category, and
 * the amount. Used by the budget's Activity popover and the reports' transaction dialog.
 */
export function TransactionLines({
  lines,
  label,
  showCategory = false,
  maxHeight = 300,
}: {
  lines: ActivityLine[];
  label: string;
  showCategory?: boolean;
  maxHeight?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const rows = useVirtualRows(box, lines.length, LINE, 8);
  return (
    <div
      ref={box}
      className={`activity-list${showCategory ? " with-category" : ""}`}
      role="table"
      aria-label={label}
      style={{ maxHeight }}
    >
      {rows.before > 0 && <div aria-hidden style={{ height: rows.before }} />}
      {lines.slice(rows.start, rows.end).map((l) => (
        <div role="row" key={l.key} className="activity-line">
          <span role="cell" className="muted">
            {formatDate(l.date)}
          </span>
          <span role="cell" title={l.memo ? `${l.payee} · ${l.memo}` : l.payee}>
            {l.payee}
            <small>
              {l.account}
              {l.memo && ` · ${l.memo}`}
            </small>
          </span>
          {showCategory && (
            <span role="cell" className="activity-category">
              {l.category}
            </span>
          )}
          <span role="cell" className={`num ${tone(l.amount)}`}>
            {money(l.amount)}
          </span>
        </div>
      ))}
      {rows.after > 0 && <div aria-hidden style={{ height: rows.after }} />}
    </div>
  );
}
