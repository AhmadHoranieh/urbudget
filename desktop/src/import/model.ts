import type { BankField, BankFixes, BankSession, BankStructure, LeftOutReason, Statement, StatementLine } from "../bridge";
import type { BankColumns } from "../types";

/** What a line left out is, by why. */
export const LEFT_OUT: Record<LeftOutReason, string> = {
  pending: "Not booked yet",
  declined: "Declined or cancelled",
  otherAccount: "Another account's",
  otherCurrency: "In another currency",
  ownBalances: "Between your own balances",
  balance: "A balance or a total",
  aboveHeader: "Above the header",
  noDate: "No date",
  noAmount: "No amount",
  zero: "Nothing moved",
  corrected: "Corrected by the bank",
  repeatedHeader: "The header row again",
  inWholeBatch: "In a batch imported as one entry",
  imported: "Imported before",
};
/** Lines left out for these reasons can be included anyway (bank_statement.rs `includable`). */
export const INCLUDABLE: ReadonlySet<LeftOutReason> = new Set([
  "pending",
  "declined",
  "otherCurrency",
  "ownBalances",
  "balance",
  "noDate",
  "noAmount",
]);
export const FIELDS: Record<BankField, string> = { date: "Date", payee: "Payee", memo: "Memo", amount: "Amount" };

/** Why a line is left out, with what the file says of it (the state, the currency, the account). */
export function leftOutText(line: StatementLine) {
  if (line.status.kind !== "leftOut") return "";
  const { reason, detail } = line.status;
  if (reason === "otherAccount" && detail) return `Account ${detail}`;
  if (reason === "otherCurrency" && detail) return `In ${detail}`;
  return detail && ["pending", "declined", "ownBalances"].includes(reason) ? `${LEFT_OUT[reason]} (${detail})` : LEFT_OUT[reason];
}

export type Filter = "all" | "attention" | "leftOut" | "edited";
export const shown = (line: StatementLine, filter: Filter) =>
  filter === "all" ||
  (filter === "attention" && line.status.kind === "attention") ||
  (filter === "leftOut" && line.status.kind === "leftOut") ||
  (filter === "edited" && (!!line.fixed || !!line.included));
export const leftOut = (st: Statement) => Object.values(st.counts.leftOut).reduce((a, n) => a + (n ?? 0), 0);

/** A statement the editor opens on by itself for: lines to fix, none that read, or a question to answer. */
export const needsEditor = (st: Statement) =>
  st.counts.attention > 0 || st.counts.ready === 0 || !!st.dateOrder?.unconfirmed || !!st.signs?.unconfirmed;

/** Changes to a session, made against its current revision. */
export const fixesFor = (session: BankSession, change: Omit<Partial<BankFixes>, "scope" | "baseRevision" | "baseStructure">): BankFixes => ({
  scope: session.scope,
  baseRevision: session.revision,
  baseStructure: session.structure,
  ...change,
});
/** The session read another way. */
export const restructure = (session: BankSession, change: Partial<BankStructure>) =>
  fixesFor(session, { structure: { ...session.structure, ...change } });

/** What a CSV column can hold, for choosing it. */
export const ROLES: [keyof BankColumns, string][] = [
  ["date", "Date"],
  ["payee", "Payee"],
  ["memo", "Memo"],
  ["amount", "Amount"],
  ["outflow", "Money out"],
  ["inflow", "Money in"],
  ["id", "Bank ID"],
];
/** What each column holds now, by its place. */
export function roles(headers: string[], columns: BankColumns | undefined | null) {
  const out: (keyof BankColumns | null)[] = headers.map(() => null);
  for (const [role] of ROLES) {
    const name = columns?.[role];
    const at = name ? headers.findIndex((h) => h.trim() === name.trim()) : -1;
    if (at >= 0) out[at] = role;
  }
  return out;
}
/** The columns with one column's role changed: a role is one column's at a time. */
export function withRole(headers: string[], columns: BankColumns | undefined | null, column: number, role: keyof BankColumns | null) {
  const next: BankColumns = { ...(columns ?? {}) };
  for (const [r] of ROLES) if (next[r] && next[r]!.trim() === headers[column]?.trim()) next[r] = null;
  if (role) next[role] = headers[column];
  // One amount column, or money out and in apart.
  if (role === "amount") next.outflow = next.inflow = null;
  if (role === "outflow" || role === "inflow") next.amount = null;
  return next;
}

/** A date the orders read differently, read day first and month first. */
export function readings(example: string): { dmy: string; mdy: string } | null {
  const parts = example.match(/(\d{1,2})\D(\d{1,2})\D(\d{2,4})/);
  if (!parts) return null;
  const [, a, b, y] = parts;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const name = (d: number, m: number) =>
    new Date(Date.UTC(year, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return { dmy: name(Number(a), Number(b)), mdy: name(Number(b), Number(a)) };
}
