import { useEffect, useState } from "react";
import { CircleCheck, CreditCard, MessageSquareText, Settings2, Target, TriangleAlert, X } from "lucide-react";
import { CategoryNotes, TargetEditor } from "./TargetEditor";
import { AUTO_ASSIGN, QuickAssign } from "./QuickAssign";
import { editableAmount, evaluateAmount, money, monthOnly, shiftMonth, tone } from "./format";
import { categoryState, targetText, type CategorySummary } from "./CategoryRow";
import { MoveList } from "./MovesPopover";
import { categoryMoves } from "./moves";
import { CategoryLoans } from "./LoanHeader";
import type { Budget, Category, Summary } from "./types";
import type { TargetMonthContext } from "./TargetFields";

/**
 * History entries name a quick-assign option by its internal name; show its label. Older
 * entries say "Auto-assign" and "Ready to assign", so they read like new ones.
 */
const moveText = (text: string) =>
  text
    .replace(/^(?:Auto-assign|Quick assign): (\w+)/, (whole, mode: string) => {
      const option = AUTO_ASSIGN.find((a) => a.mode === mode);
      return option ? `Quick assign: ${option.label.toLowerCase()}` : whole.replace("Auto-assign", "Quick assign");
    })
    .replace(/\bReady to assign\b/g, "Unassigned");
/** "Quick assign: underfunded (38 categories)" as the change and its quieter detail. */
const moveParts = (text: string) => {
  const m = moveText(text).match(/^(.*?) \((\d+ categor(?:y|ies))\)$/);
  return m ? { what: m[1], detail: m[2] } : { what: moveText(text), detail: "" };
};
/** A sign column for the month's sum, so the amounts line up as one addition. */
const Op = ({ n }: { n: number }) => <span className="op">{n < 0 ? "−" : "+"}</span>;

/** An amount that can be left empty: math allowed, Enter or leaving saves, Escape puts it back. */
function OptionalAmountInput({
  id,
  amount,
  onSave,
}: {
  id: string;
  amount: number | undefined;
  onSave: (amount: number | undefined) => void;
}) {
  const shown = amount === undefined ? "" : money(amount);
  const editable = amount === undefined ? "" : editableAmount(amount);
  const [value, setValue] = useState(shown);
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!focused) setValue(shown);
  }, [shown, focused]);
  const commit = () => {
    try {
      const parsed = value.trim() ? evaluateAmount(value) : undefined;
      if (parsed !== undefined && parsed < 0) throw new Error("Negative");
      setInvalid(false);
      if (parsed !== amount) onSave(parsed);
    } catch {
      setInvalid(true);
    }
  };
  return (
    <input
      id={id}
      className={`amount-input${invalid ? " invalid" : ""}`}
      aria-invalid={invalid}
      title={invalid ? "Enter an amount like 5000, or math like 2500*2" : undefined}
      inputMode="decimal"
      placeholder="Add"
      value={value}
      onFocus={(e) => {
        const input = e.currentTarget;
        setFocused(true);
        setValue(editable);
        requestAnimationFrame(() => input.select());
      }}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        commit();
        setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          const input = e.currentTarget;
          setValue(editable);
          setInvalid(false);
          requestAnimationFrame(() => input.blur());
        }
      }}
    />
  );
}

/**
 * The month's targets beside the income expected each month, as YNAB's Cost to Be Me compares
 * them. Each target's amount for the month comes from Rust (monthTarget): a refill's whole amount
 * and a yearly target's monthly share, with no carryover deducted.
 */
function TargetsAndIncome({
  budget,
  month,
  summaries,
  edit,
}: {
  budget: Budget;
  month: string;
  summaries: Map<string, CategorySummary>;
  edit: (fn: (b: Budget) => void) => void;
}) {
  const targets = budget.categories.reduce((n, c) => n + (c.hidden ? 0 : (summaries.get(c.id)?.monthTarget ?? 0)), 0);
  const income = budget.expectedIncome;
  const gap = income === undefined ? 0 : targets - income;
  return (
    <section className="month-cost">
      <h3>Targets and income</h3>
      <dl className="detail-list">
        <div>
          <dt>{monthOnly(month)}'s targets</dt>
          <dd>{money(targets)}</dd>
        </div>
        <div>
          <dt>
            <label htmlFor="expected-income">Expected income</label>
          </dt>
          <dd>
            <OptionalAmountInput
              id="expected-income"
              amount={income}
              onSave={(amount) =>
                edit((b) => {
                  if (amount === undefined) delete b.expectedIncome;
                  else b.expectedIncome = amount;
                })
              }
            />
          </dd>
        </div>
      </dl>
      {income === undefined ? (
        <p className="help">The income you expect each month, to compare with what your targets ask for.</p>
      ) : (
        <p className={`target-status${gap > 0 ? " short" : ""}`}>
          {gap > 0 ? <TriangleAlert size={14} /> : <CircleCheck size={14} />}
          <span>
            {gap > 0 ? (
              <>
                Targets are <strong>{money(gap)}</strong> more than expected income
              </>
            ) : (
              <>
                <strong>{money(-gap)}</strong> left after targets
              </>
            )}
          </span>
        </p>
      )}
    </section>
  );
}

export function BudgetInspector({
  budget,
  summary,
  summaries,
  month,
  currentMonth,
  selected,
  visibleIds,
  onAutoAssign,
  onEditCategory,
  onClear,
  edit,
  targetOpen,
  onTargetOpen,
  onSaved,
  onAsk,
  onPayCard,
}: {
  /** Opens the assistant about the selected categories (by name). */
  onAsk?: (names: string[]) => void;
  /** Pays the credit card a payment category belongs to (by account id). */
  onPayCard?: (accountId: string) => void;
  edit: (fn: (b: Budget) => void) => void;
  /** Whether the single selected category's target editor is open. */
  targetOpen: boolean;
  onTargetOpen: (open: boolean) => void;
  onSaved: (message: string) => void;
  budget: Budget;
  summary: Summary;
  summaries: Map<string, CategorySummary>;
  month: string;
  selected: Category[];
  visibleIds: string[];
  onAutoAssign: (mode: string, label: string, ids: string[], all: boolean, change: number, asOfMonth: string) => void;
  onEditCategory: (c: Category) => void;
  onClear: () => void;
} & TargetMonthContext) {
  const [showMoves, setShowMoves] = useState(false);
  const [allCategoryMoves, setAllCategoryMoves] = useState(false);
  const blank = (c: Category): CategorySummary => ({ id: c.id, assigned: 0, activity: 0, available: 0, carried: 0, needed: c.target });
  const of = (c: Category) => summaries.get(c.id) ?? blank(c);
  if (!selected.length) {
    const visible = budget.categories.filter((c) => !c.hidden);
    const carried = summary.categories.reduce((n, c) => n + c.carried, 0);
    // Uncategorized has no carryover or assignment; its current spending belongs in both
    // displayed totals. Keep category details and funding calculations on their own balances.
    const activity = summary.activity + (summary.uncategorized ?? 0);
    const available = summary.available + (summary.uncategorized ?? 0);
    const underfunded = visible.reduce((n, c) => {
      const st = categoryState(c, of(c), month);
      return n + st.needed;
    }, 0);
    const hasTargets = visible.some((c) => c.target > 0);
    const moves = [...(budget.moneyMoves ?? [])].filter((m) => m.month === month).reverse();
    return (
      <>
        <div className="inspector-head">
          <div>
            <h2>This month</h2>
            <p>Select categories to see their details.</p>
          </div>
        </div>
        <dl className="month-flow" aria-label="How Available adds up">
          <div>
            <dt title={`From ${monthOnly(shiftMonth(month, -1))}`}>Carried over</dt>
            <dd>{money(carried)}</dd>
          </div>
          <div>
            <dt>Assigned</dt>
            <dd>
              <Op n={summary.assigned} />
              {money(Math.abs(summary.assigned))}
            </dd>
          </div>
          <div>
            <dt title="Includes uncategorized spending and movements into and out of credit-card payment reserves.">Activity</dt>
            <dd>
              <Op n={activity} />
              {money(Math.abs(activity))}
            </dd>
          </div>
          <div className="total">
            <dt>Available</dt>
            <dd className={available < 0 ? "negative" : ""}>{money(available)}</dd>
          </div>
        </dl>
        {budget.categories.some((c) => c.paymentAccountId) && (
          <p className="help">Activity includes credit-card payment reserves. See Reports for purchases and refunds.</p>
        )}
        {(hasTargets || underfunded > 0) && (
          <p className={`target-status${underfunded ? " short" : ""}`}>
            {underfunded ? <TriangleAlert size={14} /> : <CircleCheck size={14} />}
            <span>
              {underfunded ? (
                <>
                  <strong>{money(underfunded)}</strong> still needed this month
                </>
              ) : (
                "This month's funding is complete"
              )}
            </span>
          </p>
        )}
        <QuickAssign
          budget={budget}
          month={month}
          ids={visibleIds}
          all
          summaries={summaries}
          readyToAssign={summary.readyToAssign}
          onApply={(mode, label, change, asOfMonth) => onAutoAssign(mode, label, visibleIds, true, change, asOfMonth)}
        />
        <TargetsAndIncome budget={budget} month={month} summaries={summaries} edit={edit} />
        <section className="recent-moves">
          <h3>Recent changes</h3>
          {moves.length ? (
            <ul>
              {(showMoves ? moves : moves.slice(0, 4)).map((m, i) => {
                const { what, detail } = moveParts(m.description);
                return (
                  <li key={i}>
                    <time>{new Date(m.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</time>
                    <span>
                      {what}
                      {detail && <small>{detail}</small>}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="help">Assignments and moves you make this month appear here.</p>
          )}
          {moves.length > 4 && (
            <button className="link-button" onClick={() => setShowMoves(!showMoves)}>
              {showMoves ? "Show fewer" : `Show all ${moves.length}`}
            </button>
          )}
        </section>
      </>
    );
  }
  const ids = selected.map((c) => c.id);
  const totals = selected.reduce(
    (t, c) => {
      const s = of(c);
      return { assigned: t.assigned + s.assigned, activity: t.activity + s.activity, available: t.available + s.available, needed: t.needed + categoryState(c, s, month).needed };
    },
    { assigned: 0, activity: 0, available: 0, needed: 0 },
  );
  const one = selected.length === 1 ? selected[0] : null;
  const s = one ? of(one) : null;
  const oneState = one && s ? categoryState(one, s, month) : null;
  // A single category's target as a sentence, with its deadline; it says what Still needed would.
  const oneTarget = one && s && oneState ? targetText(one, s, oneState) : null;
  const sentenceNeeded = oneTarget?.amount != null && oneTarget.amount === totals.needed;
  const oneMoves = one && s ? categoryMoves(budget, one.id, month, s.assigned) : [];
  const MOVES_SHOWN = 5;
  return (
    <>
      <div className="inspector-head">
        <div>
          <h2>{one ? one.name : `${selected.length} categories`}</h2>
          <p>{one ? one.group : "Selected"}</p>
        </div>
        <span className="inspector-head-actions">
          {onAsk && (
            <button
              className="icon-button"
              aria-label="Ask the assistant"
              title="Ask the assistant about this"
              onClick={() => onAsk(selected.map((c) => c.name))}
            >
              <MessageSquareText size={16} />
            </button>
          )}
          <button className="icon-button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}>
            <X size={16} />
          </button>
        </span>
      </div>
      <div className={`inspector-amount ${tone(totals.available)}`}>
        {money(totals.available, { symbol: true })} <small>{one?.paymentAccountId ? "set aside for the card" : "available"}</small>
      </div>
      {one?.paymentAccountId && onPayCard && budget.accounts.some((a) => a.id === one.paymentAccountId && !a.archived) && (
        <button className="primary pay-card" onClick={() => onPayCard(one.paymentAccountId!)}>
          <CreditCard size={15} aria-hidden /> Make a payment
        </button>
      )}
      <dl className="detail-list">
        {s && (
          <div>
            <dt>Carried from last month</dt>
            <dd>{money(s.carried)}</dd>
          </div>
        )}
        <div>
          <dt>Assigned this month</dt>
          <dd>{money(totals.assigned)}</dd>
        </div>
        <div>
          <dt>Activity this month</dt>
          <dd>{money(totals.activity)}</dd>
        </div>
        {one && one.target > 0 && (
          <div>
            <dt>
              {one.goal?.goal_type === "DEBT"
                ? "Loan payment target"
                : one.goal?.goal_type === "TB"
                  ? "Balance target"
                  : one.goal?.goal_needs_whole_amount === false
                    ? "Refill up to"
                    : "Set aside"}
            </dt>
            <dd>{money(one.target)}</dd>
          </div>
        )}
        {totals.needed > 0 && !sentenceNeeded && (
          <div>
            <dt>Still needed</dt>
            <dd className="warning-text">{money(totals.needed)}</dd>
          </div>
        )}
        {s && (s.upcoming ?? 0) > 0 && (
          <div>
            <dt>Upcoming this month</dt>
            <dd>{money(s.upcoming ?? 0)}</dd>
          </div>
        )}
      </dl>
      {oneTarget && (
        // A balance with no date isn't short this month: "more needed eventually" is no warning.
        <p className={`target-status${oneTarget.amount === null ? "" : oneState?.status === "underfunded" ? " short" : " later"}`}>
          {oneTarget.amount === null ? <CircleCheck size={14} /> : oneState?.status === "underfunded" ? <TriangleAlert size={14} /> : <Target size={14} />}
          <span>
            {oneTarget.amount !== null ? (
              <>
                <strong>{money(oneTarget.amount)}</strong> {oneTarget.words}
              </>
            ) : (
              oneTarget.words
            )}
          </span>
        </p>
      )}
      {totals.available < 0 && (
        <p className="notice error">Overspent. Select the Available amount to cover it from another category.</p>
      )}
      {/* A loan's payment category: the loan it pays, and paying it (LoanHeader.tsx). */}
      {one && !targetOpen && (
        <CategoryLoans
          budget={budget}
          category={one}
          balances={new Map(summary.accounts.map((a) => [a.id, a.balance]))}
          edit={edit}
          onSaved={onSaved}
        />
      )}
      {one && (
        <TargetEditor category={one} month={month} currentMonth={currentMonth} edit={edit} open={targetOpen} onOpenChange={onTargetOpen} onSaved={onSaved} />
      )}
      {!targetOpen && (
        <QuickAssign
          budget={budget}
          month={month}
          ids={ids}
          all={false}
          summaries={summaries}
          readyToAssign={summary.readyToAssign}
          onApply={(mode, label, change, asOfMonth) => onAutoAssign(mode, label, ids, false, change, asOfMonth)}
        />
      )}
      {one && oneMoves.length > 0 && (
        <section className="recent-moves">
          <h3>Moves this month</h3>
          <MoveList
            lines={allCategoryMoves ? oneMoves : oneMoves.slice(-MOVES_SHOWN)}
            label={`${one.name} moves this month`}
          />
          {oneMoves.length > MOVES_SHOWN && (
            <button className="link-button" onClick={() => setAllCategoryMoves(!allCategoryMoves)}>
              {allCategoryMoves ? "Show fewer" : `Show all ${oneMoves.length}`}
            </button>
          )}
        </section>
      )}
      {one && (
        <>
          <CategoryNotes category={one} edit={edit} />
          <button className="link-button" onClick={() => onEditCategory(one)}>
            <Settings2 size={14} /> Name, group and visibility…
          </button>
        </>
      )}
    </>
  );
}
