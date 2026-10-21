import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ChevronRight, LoaderCircle } from "lucide-react";
import { api } from "./bridge";
import { useCalculationMonth } from "./useCalculationMonth";
import { Modal } from "./forms";
import { money, monthOnly, shiftMonth } from "./format";
import type { CategorySummary } from "./CategoryRow";
import type { Budget, Summary } from "./types";

type Group = "fund" | "history" | "cleanup";
export const AUTO_ASSIGN: { mode: string; label: string; group: Group; hint: string }[] = [
  { mode: "underfunded", label: "Underfunded", group: "fund", hint: "Assign what targets still need and cover overspending." },
  { mode: "assignedLastMonth", label: "Assigned last month", group: "history", hint: "Assign what each category got last month." },
  { mode: "spentLastMonth", label: "Spent last month", group: "history", hint: "Assign what each category spent last month." },
  { mode: "averageAssigned", label: "Average assigned", group: "history", hint: "Assign each category's 12-month average assignment." },
  { mode: "averageSpent", label: "Average spent", group: "history", hint: "Assign each category's 12-month average spending." },
  { mode: "reduceOverfunding", label: "Reduce overfunding", group: "cleanup", hint: "Return what's beyond each target to Unassigned." },
  { mode: "resetAvailable", label: "Reset available amounts", group: "cleanup", hint: "Bring every Available to 0.00." },
  { mode: "resetAssigned", label: "Reset assigned amounts", group: "cleanup", hint: "Set this month's assignments to 0.00." },
];
const GROUPS: { id: Group; title: string }[] = [
  { id: "fund", title: "Fund targets" },
  { id: "history", title: "Repeat past months" },
  { id: "cleanup", title: "Clean up" },
];
/** Options that take money back from every category they touch. */
const RESETS = new Set(["resetAvailable", "resetAssigned"]);

export const autoAssignAction = (mode: string, month: string, categories: string[], all: boolean, asOfMonth?: string) => ({
  type: "autoAssign",
  month,
  mode,
  categories,
  // Assigning to every category never assigns more than Ready to Assign holds.
  limitToAvailable: all,
  ...(asOfMonth ? { expectedAsOfMonth: asOfMonth } : {}),
});

type Change = { id: string; before: number; after: number };
/** One option's effect: the net change to what's assigned, and each category it changes. */
type Outcome = { total: number; changes: Change[] };

type Preview = Record<string, Outcome | null>;
/**
 * Previews already worked out, per budget (the same object until it changes) and per month and
 * selection. Coming back to the budget, another month or an earlier selection costs nothing.
 */
const previews = new WeakMap<Budget, Map<string, Preview>>();

/** What each quick-assign option would change, worked out in one call. Null while it works. */
function useAutoAssignPreview(budget: Budget, month: string, ids: string[], all: boolean, asOfMonth: string) {
  const key = JSON.stringify([month, asOfMonth, all, ids]);
  const cached = () => previews.get(budget)?.get(key) ?? null;
  const [state, setState] = useState<{ budget: Budget; key: string; preview: Preview | null; error: boolean }>(() => ({ budget, key, preview: cached(), error: false }));
  const matches = state.budget === budget && state.key === key;
  const preview = matches ? state.preview : cached();
  const error = matches && state.error;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const known = cached();
    setState({ budget, key, preview: known, error: false });
    if (known) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      let out: Preview;
      try {
        const result = await api.autoAssignPreview(budget, month, ids, all, { asOfMonth, signal: controller.signal });
        out = Object.fromEntries(
          AUTO_ASSIGN.map(({ mode }) => {
            const changes = result[mode];
            return [mode, changes ? { total: changes.reduce((n, c) => n + c.after - c.before, 0), changes } : null];
          }),
        );
      } catch {
        if (!controller.signal.aborted) setState({ budget, key, preview: null, error: true });
        return;
      }
      if (controller.signal.aborted) return;
      if (!previews.has(budget)) previews.set(budget, new Map());
      previews.get(budget)!.set(key, out);
      setState({ budget, key, preview: out, error: false });
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [budget, key, attempt]);
  return { preview, error, retry: () => setAttempt((n) => n + 1) };
}

/** "+1,234.56" or "−1,234.56", with a real minus sign. */
const signed = (n: number) => `${n < 0 ? "−" : "+"}${money(Math.abs(n))}`;

export function QuickAssign({
  budget,
  month,
  ids,
  all,
  summaries,
  readyToAssign,
  onApply,
}: {
  budget: Budget;
  month: string;
  ids: string[];
  /** Every visible category, rather than a selection. */
  all: boolean;
  summaries: Map<string, CategorySummary>;
  readyToAssign: number;
  onApply: (mode: string, label: string, change: number, asOfMonth: string) => void;
}) {
  const asOfMonth = useCalculationMonth();
  const { preview, error, retry } = useAutoAssignPreview(budget, month, ids, all, asOfMonth);
  const [open, setOpen] = useState<string | null>(null);
  const option = AUTO_ASSIGN.find((o) => o.mode === open);
  return (
    <section className="quick-assign" aria-label="Quick assign">
      <h3>
        Quick assign {!preview && !error && <LoaderCircle size={12} className="spin muted" aria-label="Calculating" />}
      </h3>
      <p className="quick-hint">Each option shows its changes first.</p>
      {error && (
        <p className="form-error" role="alert">
          Could not calculate these options. <button className="link-button" onClick={retry}>Retry preview</button>
        </p>
      )}
      {GROUPS.map((g) => (
        <div key={g.id} className="quick-group" role="group" aria-label={g.title}>
          <h4>{g.title}</h4>
          {AUTO_ASSIGN.filter((o) => o.group === g.id).map(({ mode, label, hint }) => {
            const outcome = preview?.[mode];
            const change = outcome?.total ?? 0;
            const ready = preview !== null;
            return (
              <button
                key={mode}
                className="quick-row"
                title={hint}
                disabled={error || (ready && (!outcome || !outcome.changes.length))}
                onClick={() => setOpen(mode)}
              >
                <span className="quick-label">{label}</span>
                <span className={`quick-amount${change > 0 ? " up" : change < 0 ? " down" : ""}`}>
                  {!ready ? "…" : outcome === null ? "—" : outcome?.changes.length ? signed(change) : "No change"}
                </span>
                <ChevronRight size={14} className="quick-chevron" aria-hidden />
              </button>
            );
          })}
        </div>
      ))}
      {option &&
        createPortal(
          <QuickAssignDialog
            option={option}
            outcome={error ? null : preview ? preview[option.mode] : undefined}
            budget={budget}
            month={month}
            asOfMonth={asOfMonth}
            ids={ids}
            count={ids.length}
            all={all}
            summaries={summaries}
            readyToAssign={readyToAssign}
            close={() => setOpen(null)}
            confirm={(change) => {
              setOpen(null);
              onApply(option.mode, option.label, change, asOfMonth);
            }}
          />,
          document.body,
        )}
    </section>
  );
}

/** What an option does, in words, for this month. */
function explain(mode: string, month: string, all: boolean) {
  const now = monthOnly(month);
  const last = monthOnly(shiftMonth(month, -1));
  switch (mode) {
    case "underfunded":
      return all
        ? `Assigns what each category still needs for its ${now} target, and covers overspending. It never assigns more than Unassigned holds: overspent categories go first, then the targets due soonest, then credit card payments.`
        : `Assigns what each category still needs for its ${now} target, and covers overspending. Overspent categories go first, then the targets due soonest.`;
    case "assignedLastMonth":
      return `Replaces each category's ${now} assignment with what you assigned to it in ${last}.`;
    case "spentLastMonth":
      return `Replaces each category's ${now} assignment with what it spent in ${last}. Categories that spent nothing get 0.00, and credit card payments stay as they are.`;
    case "averageAssigned":
      return `Replaces each category's ${now} assignment with its average monthly assignment over the last 12 months, counted from the first month it was assigned to or spent from.`;
    case "averageSpent":
      return `Replaces each category's ${now} assignment with its average monthly spending over the last 12 months, counted from the first month it was assigned to or spent from. Credit card payments stay as they are.`;
    case "reduceOverfunding":
      return `Lowers the ${now} assignment of categories holding more than their target needs, and returns the extra to Unassigned. A credit card payment without a target keeps what its card owes. Other categories without a target stay as they are.`;
    case "resetAvailable":
      return `Changes each category's ${now} assignment so its Available becomes 0.00. Money set aside, including what carried over from ${last}, returns to Unassigned, so a category holding older money gets a negative assignment. Overspent categories are covered.`;
    case "resetAssigned":
      return `Sets each category's ${now} assignment to 0.00. Carried-over money and spending stay, so each Available drops by what was assigned.`;
    default:
      return "";
  }
}

type Row = Change & { name: string; card: boolean; availableBefore: number; availableAfter: number };

/** The biggest change, told as a sentence with its real amounts. */
function example(mode: string, month: string, r: Row) {
  const last = monthOnly(shiftMonth(month, -1));
  const now = monthOnly(month);
  const moves = `its ${now} assignment goes from ${money(r.before)} to ${money(r.after)}`;
  const why: Record<string, string> = {
    underfunded: `${r.name} still needs ${money(r.after - r.before)}, so ${moves}.`,
    assignedLastMonth: `You assigned ${money(r.after)} to ${r.name} in ${last}, so ${moves}.`,
    spentLastMonth: `${r.name} spent ${money(r.after)} in ${last}, so ${moves}.`,
    averageAssigned: `${r.name} was assigned ${money(r.after)} a month on average, so ${moves}.`,
    averageSpent: `${r.name} spent ${money(r.after)} a month on average, so ${moves}.`,
    reduceOverfunding: `${r.name} holds ${money(r.before - r.after)} more than ${r.card ? "its card owes" : "its target needs"}, so ${moves}.`,
    resetAvailable: `${r.name} has ${money(r.availableBefore)} available, so ${moves}.`,
    resetAssigned: `${r.name} has ${money(r.before)} assigned in ${now}, so ${moves}.`,
  };
  return `${why[mode] ?? `${r.name}: ${moves}.`} Its Available goes from ${money(r.availableBefore)} to ${money(r.availableAfter)}.`;
}

/** Explains an option with the budget's own numbers, and applies it only on confirmation. */
function QuickAssignDialog({
  option,
  outcome,
  budget,
  month,
  asOfMonth,
  ids,
  count,
  all,
  summaries,
  readyToAssign,
  close,
  confirm,
}: {
  option: (typeof AUTO_ASSIGN)[number];
  /** Undefined while the preview is still being worked out; null when it failed. */
  outcome: Outcome | null | undefined;
  budget: Budget;
  month: string;
  asOfMonth: string;
  ids: string[];
  count: number;
  all: boolean;
  summaries: Map<string, CategorySummary>;
  readyToAssign: number;
  close: () => void;
  confirm: (change: number) => void;
}) {
  const key = JSON.stringify([month, asOfMonth, option.mode, ids, all]);
  const [result, setResult] = useState<{ budget: Budget; key: string; summary?: Summary; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const resultMatches = result?.budget === budget && result.key === key;
  const after = resultMatches ? result.summary : undefined;
  const resultError = resultMatches ? result.error : undefined;
  useEffect(() => {
    setResult(null);
    if (!outcome) return;
    const controller = new AbortController();
    void api.autoAssignResult(budget, month, option.mode, ids, all, { asOfMonth, signal: controller.signal })
      .then((summary) => {
        if (controller.signal.aborted) return;
        const categories = new Set(summary.categories.map((c) => c.id));
        if (outcome.changes.some((c) => !categories.has(c.id))) throw new Error("The resulting summary is missing a changed category.");
        setResult({ budget, key, summary });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResult({ budget, key, error: String(error) });
      });
    return () => controller.abort();
  }, [budget, key, outcome, attempt]);
  const reset = RESETS.has(option.mode);
  const name = (id: string) => budget.categories.find((c) => c.id === id)?.name ?? id;
  const availableAfter = new Map(after?.categories.map((c) => [c.id, c.available]) ?? []);
  const rows: Row[] = (after ? outcome?.changes ?? [] : [])
    .map((c) => {
      const availableBefore = summaries.get(c.id)?.available ?? 0;
      const card = !!budget.categories.find((x) => x.id === c.id)?.paymentAccountId;
      return { ...c, name: name(c.id), card, availableBefore, availableAfter: availableAfter.get(c.id)! };
    })
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before) || a.name.localeCompare(b.name));
  // The example names a category that gets money where it can: "spent 0.00 on average" explains little.
  const sample = RESETS.has(option.mode) ? rows[0] : (rows.find((r) => r.after > 0) ?? rows[0]);
  const total = outcome?.total ?? 0;
  const unassignedAfter = after?.readyToAssign ?? 0;
  const shortfalls = after?.futureShortfalls ?? [];
  const overspent = rows.filter((r) => r.availableAfter < 0 && r.availableAfter < r.availableBefore).length;
  const scope = all
    ? `All ${count} visible ${count === 1 ? "category" : "categories"}`
    : `${count} selected ${count === 1 ? "category" : "categories"}`;
  return (
    <Modal title={`Quick assign: ${option.label}`} close={close}>
      <div className="qa-dialog">
        <p className="qa-lead">{explain(option.mode, month, all)}</p>
        <p className="qa-scope">
          {scope} in {monthOnly(month)}
        </p>
        {resultError ? (
          <p className="notice error" role="alert">
            Could not calculate the resulting budget. <button className="link-button" onClick={() => setAttempt((n) => n + 1)}>Retry result</button>
          </p>
        ) : outcome === undefined || (outcome && !after) ? (
          <p className="qa-loading">
            <LoaderCircle size={14} className="spin" /> Working out the changes…
          </p>
        ) : outcome === null ? (
          <p className="notice error">This option can’t be worked out for these categories.</p>
        ) : (
          <>
            <div className="qa-stats">
              <div>
                <span>{total >= 0 ? "Assigns" : "Returns"}</span>
                <strong className={total > 0 ? "positive" : ""}>{money(Math.abs(total))}</strong>
                <small>{total >= 0 ? "to categories" : "from assignments"}</small>
              </div>
              <div>
                <span>Unassigned</span>
                <strong className={unassignedAfter < 0 ? "negative" : ""}>{money(unassignedAfter)}</strong>
                <small>now {money(readyToAssign)}</small>
              </div>
              <div>
                <span>Categories</span>
                <strong>{rows.length}</strong>
                <small>of {count} change</small>
              </div>
            </div>
            {sample && (
              <p className="qa-example">
                <span>For example</span>
                {example(option.mode, month, sample)}
              </p>
            )}
            {shortfalls.length > 0 && (
              <p className="qa-warning" role="alert">
                <AlertTriangle size={15} />
                <span>Future funding still needs attention: {shortfalls.map((s) => `${monthOnly(s.month)} is short by ${money(s.amount)}`).join("; ")}. Returned money covers these shortfalls before becoming Unassigned.</span>
              </p>
            )}
            <div className="qa-table" role="table" aria-label="Changes by category">
              <div className="qa-tr qa-th" role="row">
                <span role="columnheader">Category</span>
                <span role="columnheader">Assigned</span>
                <span role="columnheader">Change</span>
                <span role="columnheader">Available after</span>
              </div>
              <div className="qa-body">
                {rows.map((r) => (
                  <div key={r.id} className="qa-tr" role="row">
                    <span role="cell" className="qa-name">
                      {r.name}
                    </span>
                    <span role="cell" className="num">
                      <span className="muted">{money(r.before)} →</span> {money(r.after)}
                    </span>
                    <span role="cell" className={`num ${r.after > r.before ? "positive" : "muted"}`}>
                      {signed(r.after - r.before)}
                    </span>
                    <span role="cell" className={`num${r.availableAfter < 0 ? " negative" : ""}`}>
                      {money(r.availableAfter)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {count > rows.length && (
              <p className="qa-same">
                {count - rows.length} {count - rows.length === 1 ? "category stays" : "categories stay"} the same.
              </p>
            )}
            {(unassignedAfter < 0 || overspent > 0) && (
              <p className="qa-warning" role="alert">
                <AlertTriangle size={15} />
                <span>
                  {unassignedAfter < 0 && `This assigns more than you have: Unassigned would be ${money(unassignedAfter)}. `}
                  {overspent > 0 &&
                    `${overspent} ${overspent === 1 ? "category ends" : "categories end"} up overspent, with Available below 0.00.`}
                </span>
              </p>
            )}
          </>
        )}
        <div className="modal-actions qa-actions">
          <small className="muted">You can undo this afterwards.</small>
          <button className="secondary" onClick={close} data-autofocus={reset || undefined}>
            Cancel
          </button>
          <button
            className={reset ? "danger" : "primary"}
            disabled={!after || !!resultError || !outcome?.changes.length}
            data-autofocus={!reset || undefined}
            onClick={() => confirm(total)}
          >
            {rows.length ? `Apply to ${rows.length} ${rows.length === 1 ? "category" : "categories"}` : "Apply"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
