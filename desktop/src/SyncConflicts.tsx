// Settings › Account & sync: the changes two devices made differently, record by record, for
// the person to choose between. Everything else was already combined by sync (sync_merge.rs).
import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { BudgetSync, SyncConflict } from "./cloud";
import { errorText, formatDate, money, monthName } from "./format";
import { Modal } from "./forms";
import { useToast } from "./ui";

export type Side = "local" | "cloud";

const KINDS: Record<SyncConflict["kind"], string> = {
  account: "Account",
  category: "Category",
  transaction: "Transaction",
  assignment: "Assigned",
  schedule: "Scheduled",
  payee: "Payee",
  payeeRule: "Bank name",
  monthNote: "Month note",
  loan: "Loan",
  budget: "Budget",
  setting: "Setting",
};
const FIELDS: Record<string, string> = {
  name: "Name",
  group: "Group",
  target: "Target",
  goal: "Target",
  note: "Note",
  hidden: "Hidden",
  memo: "Memo",
  payee: "Payee",
  date: "Date",
  accountId: "Account",
  amount: "Amount",
  status: "Cleared",
  flag: "Flag",
  approved: "Approved",
  importedPayee: "Bank's payee name",
  openingBalance: "Starting balance",
  archived: "Closed",
  kind: "Type",
  accountType: "Account type",
  onBudget: "On budget",
  netWorth: "In net worth",
  nextDate: "Next date",
  anchorDate: "First date",
  frequency: "Repeats",
  paused: "Paused",
  transaction: "Transaction",
  match: "Matches",
  categoryId: "Category",
  paymentAccountId: "Card",
  currency: "Currency",
  numberFormat: "Number format",
  dateFormat: "Date format",
  categoryOrder: "Category order",
  groupOrder: "Group order",
};
const MONEY = new Set(["target", "openingBalance", "monthlyPayment", "monthlyFees"]);
const DATES = new Set(["date", "nextDate", "anchorDate"]);
const BOOLEANS: Record<string, [string, string]> = {
  approved: ["Approved", "Not approved"],
  hidden: ["Hidden", "Shown"],
  archived: ["Closed", "Open"],
  paused: ["Paused", "Active"],
  onBudget: ["On budget", "Off budget"],
  netWorth: ["Counted", "Not counted"],
};
const WORDS: Record<string, string> = {
  uncleared: "Uncleared",
  cleared: "Cleared",
  reconciled: "Reconciled",
  cash: "Cash",
  credit: "Credit card",
  tracking: "Tracking",
};

const fieldLabel = (field: string) =>
  FIELDS[field] ?? field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

type Money = {
  amount?: number | null;
  lines?: { category: string | null; transfer: string | null; amount: number }[];
  transfer?: string | null;
  payee?: string;
  account?: string;
};
/** A transaction's money: the amount, then where it went. */
function moneyLine(m: Money) {
  const where = (l: { category: string | null; transfer: string | null }) =>
    l.transfer ? `Transfer: ${l.transfer}` : (l.category ?? "Ready to Assign");
  const lines = m.lines ?? [];
  const to = m.transfer
    ? `Transfer: ${m.transfer}`
    : lines.length > 1
      ? lines.map((l) => `${where(l)} ${money(l.amount)}`).join(", ")
      : lines[0]
        ? where(lines[0])
        : "";
  return [typeof m.amount === "number" ? money(m.amount) : "", to].filter(Boolean).join(" · ");
}

/** One side's version, as the person reads it. */
export function shownValue(c: SyncConflict, v: unknown): string {
  if (!c.field) {
    const changed = (v as { changed?: string[] } | null)?.changed ?? [];
    return v == null ? "Deleted" : changed.length ? `Edited: ${changed.map(fieldLabel).join(", ")}` : "Edited";
  }
  if (v == null) return c.field === "flag" ? "No flag" : "None";
  if (c.kind === "transaction" && c.field === "amount") return moneyLine(v as Money);
  if (c.kind === "schedule" && c.field === "transaction") {
    const m = v as Money;
    return [m.payee, moneyLine(m), m.account].filter(Boolean).join(" · ");
  }
  if (typeof v === "number") return MONEY.has(c.field) || c.kind === "assignment" ? money(v) : String(v);
  if (typeof v === "boolean") return BOOLEANS[c.field]?.[v ? 0 : 1] ?? (v ? "Yes" : "No");
  if (typeof v === "string") {
    if (DATES.has(c.field) && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDate(v);
    if (c.field === "flag") return v.charAt(0).toUpperCase() + v.slice(1);
    return WORDS[v] && ["status", "kind"].includes(c.field) ? WORDS[v] : v === "" ? "(empty)" : v;
  }
  if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? v.join(", ") : `${v.length} items`;
  const flat = Object.entries(v as Record<string, unknown>).filter(([, x]) => x === null || typeof x !== "object");
  return flat.length ? flat.map(([k, x]) => `${fieldLabel(k)}: ${MONEY.has(k) || k === "amount" ? money(Number(x)) : String(x)}`).join(" · ") : "Edited";
}

/** The record's name; a setting by what it's called, a month note by its month. */
function recordName(c: SyncConflict) {
  if (c.kind === "setting") return fieldLabel(c.label);
  if (c.kind === "monthNote" && /^\d{4}-\d{2}/.test(c.label)) return monthName(c.label.slice(0, 7));
  return c.label || "(no name)";
}

/** What else tells the record apart. */
export function aboutText(c: SyncConflict): string {
  const a = c.about as { date?: string | null; account?: string; amount?: number | null; month?: string; group?: string; match?: string };
  switch (c.kind) {
    case "transaction":
    case "schedule":
      return [a.date ? (c.kind === "schedule" ? `Next ${formatDate(a.date)}` : formatDate(a.date)) : "", a.account, typeof a.amount === "number" ? money(a.amount) : ""]
        .filter(Boolean)
        .join(" · ");
    case "assignment":
      return a.month ? monthName(a.month) : "";
    case "category":
      return a.group ?? "";
    case "payeeRule":
      return a.match ? `Matches “${a.match}”` : "";
    default:
      return "";
  }
}

export function SyncConflicts({
  budget,
  close,
  resolve,
}: {
  budget: BudgetSync;
  close: () => void;
  /** Merges again with these answers. */
  resolve: (choices: Record<string, Side>) => Promise<void>;
}) {
  const toast = useToast();
  const conflicts = budget.conflicts ?? [];
  const [choices, setChoices] = useState<Record<string, Side>>({});
  const [busy, setBusy] = useState(false);
  const here = "This computer";
  const there = budget.device ?? "The cloud copy";
  const shown = conflicts.slice(0, 100);
  const all = (side: Side) => setChoices(Object.fromEntries(conflicts.map((c) => [c.key, side])));
  const answered = conflicts.every((c) => choices[c.key]);
  return (
    <Modal title={`Changed in two places: ${budget.name}`} close={close} wide>
      <p className="sync-conflicts-lead">
        Everything else from {budget.device ?? "your other device"} and this computer was combined.{" "}
        {conflicts.length === 1 ? "This was" : `These ${conflicts.length} were`} changed differently on both: choose which to keep.
      </p>
      {conflicts.length > 1 && (
        <div className="sync-conflicts-all">
          <span className="muted">Keep all:</span>
          <button className="secondary" onClick={() => all("local")}>
            {here}'s
          </button>
          <button className="secondary" onClick={() => all("cloud")}>
            {there}'s
          </button>
        </div>
      )}
      <ul className="sync-conflicts">
        {shown.map((c) => {
          const about = aboutText(c);
          return (
            <li key={c.key} className="sync-conflict">
              <div className="sync-conflict-record">
                <strong>
                  {KINDS[c.kind] ?? "Record"}: {recordName(c)}
                </strong>
                {about && <small className="muted">{about}</small>}
              </div>
              <div className="sync-conflict-field">{c.field ? fieldLabel(c.field) : "Deleted on one, edited on the other"}</div>
              <div className="sync-conflict-options" role="radiogroup" aria-label={`${KINDS[c.kind]} ${recordName(c)}: ${c.field ? fieldLabel(c.field) : "keep or delete"}`}>
                {(["local", "cloud"] as const).map((side) => (
                  <label key={side} className={`sync-conflict-option${choices[c.key] === side ? " chosen" : ""}`}>
                    <input type="radio" name={c.key} checked={choices[c.key] === side} onChange={() => setChoices({ ...choices, [c.key]: side })} />
                    <span className="sync-conflict-side">{side === "local" ? here : there}</span>
                    <span className="sync-conflict-value">{shownValue(c, side === "local" ? c.local : c.remote)}</span>
                  </label>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      {conflicts.length > shown.length && (
        <p className="muted">And {conflicts.length - shown.length} more. Keep all chooses for those too.</p>
      )}
      <div className="modal-actions">
        <button className="secondary" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !answered}
          onClick={async () => {
            setBusy(true);
            try {
              await resolve(choices);
              close();
            } catch (e) {
              toast({ message: errorText(e), tone: "error" });
              setBusy(false);
            }
          }}
        >
          {busy && <LoaderCircle size={14} className="spin" />} Keep these and sync
        </button>
      </div>
    </Modal>
  );
}
