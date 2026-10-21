import { useMemo } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Popover, type Anchor } from "./ui";
import { money, monthName } from "./format";
import { categoryMoves, type CategoryMove } from "./moves";
import type { Budget } from "./types";

const day = (at: string) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const signed = (n: number) => `${n < 0 ? "−" : "+"}${money(Math.abs(n))}`;

/** A category's moves: when, what (where the money came from or went), and the change. */
export function MoveList({ lines, label }: { lines: CategoryMove[]; label: string }) {
  return (
    <ul className="move-list" aria-label={label}>
      {lines.map((l) => (
        <li key={l.key} className={l.at ? undefined : "earlier"}>
          {l.at ? (
            <time dateTime={l.at} title={when(l.at)}>
              {day(l.at)}
            </time>
          ) : (
            <span />
          )}
          <span>
            {l.what}
            {l.detail && <small>{l.detail}</small>}
          </span>
          <span className="move-amount">{signed(l.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The moves behind a category's Assigned for the month, adding up to it. */
export function MovesPopover({
  budget,
  categoryId,
  categoryName,
  month,
  assigned,
  anchor,
  onClose,
  onMoveFunds,
}: {
  budget: Budget;
  categoryId: string;
  categoryName: string;
  month: string;
  assigned: number;
  anchor: Anchor;
  onClose: () => void;
  onMoveFunds: () => void;
}) {
  const lines = useMemo(
    () => categoryMoves(budget, categoryId, month, assigned),
    [budget.moneyMoves, budget.categories, categoryId, month, assigned],
  );
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="bottom-end" label={`${categoryName} moves`} className="activity-popover moves-popover">
      <div className="activity-head">
        <strong>{categoryName}</strong>
        <span className="muted">Moves in {monthName(month)}</span>
      </div>
      {lines.length ? (
        <MoveList lines={lines} label={`${categoryName} moves`} />
      ) : (
        <p className="muted activity-empty">Nothing assigned or moved in this category this month.</p>
      )}
      <div className="activity-foot">
        <span>
          Assigned · <strong>{money(assigned)}</strong>
        </span>
        <button className="link-button" data-autofocus onClick={onMoveFunds}>
          <ArrowLeftRight size={13} /> Move funds…
        </button>
      </div>
    </Popover>
  );
}
