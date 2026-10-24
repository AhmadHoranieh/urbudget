import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Check, MessageSquareText, RotateCcw, Sparkles } from "lucide-react";
import type { BankFixes, BankSession, Statement, StatementLine } from "../bridge";
import type { BankColumns } from "../types";
import { Tabs, useVirtualRows } from "../ui";
import { FIELDS, INCLUDABLE, ROLES, fixesFor, leftOutText, readings, restructure, roles, shown, withRole, type Filter } from "./model";

/** Each line is this tall, so a long file only renders the lines in view. */
const LINE = 37;

/**
 * Every line of a bank file with what became of it, to fix: a cell that doesn't read, a line left
 * out to include, which column holds what, the header row, the account of several, the date order
 * the dates don't settle. Lines that still need attention stay out of the import.
 */
export function StatementGrid({
  statement,
  session,
  busy,
  assisted,
  onFix,
  onContinue,
  onAssistant,
}: {
  statement: Statement;
  session: BankSession;
  busy: boolean;
  /** Lines the assistant changed. */
  assisted: ReadonlySet<string>;
  onFix: (fixes: BankFixes) => void;
  onContinue: () => void;
  /** Hands the lines that need attention to the assistant. */
  onAssistant?: () => void;
}) {
  const [filter, setFilter] = useState<Filter>(statement.counts.attention ? "attention" : "all");
  const [editing, setEditing] = useState<{ line: string; column: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => statement.lines.filter((l) => shown(l, filter)), [statement.lines, filter]);
  const place = useMemo(() => new Map(statement.lines.map((l, i) => [l.id, i])), [statement.lines]);
  const view = useVirtualRows(scroller, lines.length, LINE);
  const table = statement.format === "csv";
  const role = useMemo(() => (table ? roles(statement.headers, statement.columns) : []), [table, statement.headers, statement.columns]);
  const count = (f: Filter) => statement.lines.filter((l) => shown(l, f)).length;
  const s = session.structure;
  const commit = (line: StatementLine, column: number, to: string) => {
    setEditing(null);
    if (to.trim() === line.cells[column]?.trim()) return;
    onFix(fixesFor(session, { cells: [{ line: line.id, lineVersion: line.version, column, from: line.cells[column] ?? "", to }] }));
  };
  const include = (line: StatementLine, on: boolean) =>
    onFix(fixesFor(session, { include: [{ line: line.id, lineVersion: line.version, include: on }] }));
  const revert = (line: StatementLine) => onFix(fixesFor(session, { revert: [{ line: line.id, lineVersion: line.version }] }));
  const asColumn = (column: number, value: string) =>
    onFix(restructure(session, { columns: withRole(statement.headers, statement.columns, column, (value || null) as keyof BankColumns | null) }));
  const whole = (entry: string, on: boolean) =>
    onFix(restructure(session, { wholeBatches: on ? [...(s.wholeBatches ?? []), entry] : (s.wholeBatches ?? []).filter((e) => e !== entry) }));
  const question = statement.dateOrder?.unconfirmed ? statement.dateOrder : null;
  // A file in another currency than the budget's: its lines are left out, each saying which.
  const foreign = statement.lines.find((l) => l.status.kind === "leftOut" && l.status.reason === "otherCurrency")?.status;
  const elsewhere = !statement.counts.ready && foreign?.kind === "leftOut" ? foreign.detail : null;
  const read = question && readings(question.example);
  const attention = statement.counts.attention;
  const width = Math.max(1, statement.headers.length);
  return (
    <div className="statement-editor">
      <div className="statement-bar">
        {(statement.sources?.length ?? 0) > 1 && (
          <label className="statement-source">
            Account in the file
            <select
              value={statement.source ?? 0}
              disabled={busy}
              onChange={(e) => onFix(restructure(session, { source: statement.sources![Number(e.target.value)].label }))}
            >
              {statement.sources!.map((source, i) => (
                <option key={source.label} value={i}>
                  {source.label}
                  {source.currency ? ` · ${source.currency}` : ""} · {source.lines} {source.lines === 1 ? "line" : "lines"}
                </option>
              ))}
            </select>
          </label>
        )}
        {table && (
          <label className="checkbox-label">
            <input type="checkbox" checked={s.flipSigns} disabled={busy} onChange={(e) => onFix(restructure(session, { flipSigns: e.target.checked }))} />
            Purchases are positive
          </label>
        )}
      </div>
      {elsewhere && !statement.currency && (
        <p className="statement-question" role="status">
          <AlertTriangle size={15} aria-hidden />
          The file's amounts are in {elsewhere}. Include a line to enter its amount in your budget's currency, or import the
          file into a budget in {elsewhere}.
        </p>
      )}
      {statement.currency && (
        <p className="statement-question" role="status">
          <AlertTriangle size={15} aria-hidden />
          This account's amounts are in {statement.currency}. Choose another account in the file, or include its lines with their
          amounts in your budget's currency.
        </p>
      )}
      {question && (
        <div className="statement-question" role="group" aria-label="Date order">
          <AlertTriangle size={15} aria-hidden />
          <span>
            The dates don't say whether the day or the month comes first: is <b>{question.example}</b>
          </span>
          {(["dmy", "mdy"] as const).map((order) => (
            <button
              key={order}
              className={question.order === order ? "primary small" : "secondary small"}
              disabled={busy}
              onClick={() => onFix(restructure(session, { dateOrder: { order, confirmed: true } }))}
            >
              {read ? read[order] : order === "dmy" ? "Day first" : "Month first"}
            </button>
          ))}
        </div>
      )}
      {statement.signs?.unconfirmed && (
        <div className="statement-question" role="group" aria-label="Signs">
          <AlertTriangle size={15} aria-hidden />
          <span>Every amount that reads is positive. Is money out told by the transaction types (DEBIT, POS…)?</span>
          <button className="primary small" disabled={busy} onClick={() => onFix(restructure(session, { signsByType: true }))}>
            Yes, use the types
          </button>
          <button className="secondary small" disabled={busy} onClick={() => onFix(restructure(session, { signsByType: false }))}>
            No, as written
          </button>
        </div>
      )}
      <Tabs
        label="Show lines"
        value={filter}
        onChange={setFilter}
        tabs={[
          { id: "all", label: "All", count: count("all") },
          { id: "attention", label: "Need attention", count: attention },
          { id: "leftOut", label: "Left out", count: count("leftOut") },
          { id: "edited", label: "Edited", count: count("edited") },
        ]}
      />
      <div className="table-scroll statement-grid" ref={scroller}>
        <table>
          <thead>
            {table && (
              <tr className="statement-roles">
                <th />
                {statement.headers.map((_, i) => (
                  <th key={i}>
                    <select aria-label={`What column ${i + 1} holds`} value={role[i] ?? ""} disabled={busy} onChange={(e) => asColumn(i, e.target.value)}>
                      <option value="">Not read</option>
                      {ROLES.map(([r, label]) => (
                        <option key={r} value={r}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </th>
                ))}
              </tr>
            )}
            <tr>
              <th className="statement-state">Line</th>
              {statement.headers.map((h, i) => (
                <th key={i}>{h || `Column ${i + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.before > 0 && (
              <tr aria-hidden className="spacer-row" style={{ height: view.before }}>
                <td colSpan={width + 1} />
              </tr>
            )}
            {lines.slice(view.start, view.end).map((line) => {
              const batch = line.batch !== undefined ? statement.batches?.[line.batch] : undefined;
              const kind = line.status.kind;
              return (
                <tr key={line.id} className={`statement-line ${kind}`} data-line={line.id}>
                  <td className="statement-state">
                    <LineState
                      line={line}
                      assisted={assisted.has(line.id)}
                      busy={busy}
                      onInclude={(on) => include(line, on)}
                      onRevert={() => revert(line)}
                      onHeader={table && line.status.kind === "leftOut" && line.status.reason === "aboveHeader" ? () => onFix(restructure(session, { headerLine: Number(line.id) })) : undefined}
                    >
                      {batch && batch.addsUp === false && !batch.asOne && batch.payments[0] === place.get(line.id) && (
                        <button className="link-button" disabled={busy} onClick={() => whole(batch.entry, true)}>
                          Import as one entry
                        </button>
                      )}
                      {batch?.asOne && batch.line === place.get(line.id) && (
                        <button className="link-button" disabled={busy} onClick={() => whole(batch.entry, false)}>
                          Import its payments
                        </button>
                      )}
                    </LineState>
                  </td>
                  {Array.from({ length: width }, (_, column) => {
                    const value = line.cells[column] ?? "";
                    const bad = line.status.kind === "attention" && (table ? line.status.column === column : FIELDS[line.status.field] === statement.headers[column]);
                    const changed = !!line.original?.length && (line.original[column] ?? "") !== value;
                    const open = editing?.line === line.id && editing.column === column;
                    const locked = busy || (table && role[column] === "id");
                    return (
                      <td
                        key={column}
                        className={`statement-cell${bad ? " bad" : ""}${changed ? " changed" : ""}`}
                        title={changed ? `In the file: ${line.original![column] ?? ""}` : value}
                        onDoubleClick={() => !locked && setEditing({ line: line.id, column })}
                      >
                        {open ? (
                          <CellInput value={value} onDone={(to) => (to === null ? setEditing(null) : commit(line, column, to))} />
                        ) : (
                          <button
                            type="button"
                            className="statement-value"
                            disabled={locked}
                            aria-label={`${statement.headers[column] || `Column ${column + 1}`} of line ${line.id}: ${value || "empty"}`}
                            onClick={() => setEditing({ line: line.id, column })}
                          >
                            {value || " "}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {view.after > 0 && (
              <tr aria-hidden className="spacer-row" style={{ height: view.after }}>
                <td colSpan={width + 1} />
              </tr>
            )}
          </tbody>
        </table>
        {!lines.length && <p className="help statement-empty">No lines here.</p>}
      </div>
      <div className="form-actions statement-actions">
        <span className="help">
          {statement.counts.ready} {statement.counts.ready === 1 ? "line reads" : "lines read"}
          {attention > 0 && ` · ${attention} ${attention === 1 ? "needs" : "need"} attention and won't be imported`}
        </span>
        {onAssistant && attention > 0 && (
          <button className="secondary" disabled={busy} onClick={onAssistant}>
            <MessageSquareText size={14} /> Fix with the assistant
          </button>
        )}
        <button
          className="primary"
          disabled={busy || !statement.counts.ready || !!question}
          title={question ? "Say first whether the day or the month comes first" : undefined}
          onClick={onContinue}
        >
          Continue to the review
        </button>
      </div>
    </div>
  );
}

/** What became of a line, and what can be done about it. */
function LineState({
  line,
  assisted,
  busy,
  onInclude,
  onRevert,
  onHeader,
  children,
}: {
  line: StatementLine;
  assisted: boolean;
  busy: boolean;
  onInclude: (on: boolean) => void;
  onRevert: () => void;
  onHeader?: () => void;
  /** More it offers (a batch's), on the same line. */
  children?: ReactNode;
}) {
  const s = line.status;
  const includable = s.kind === "leftOut" && INCLUDABLE.has(s.reason);
  return (
    <span className="line-state">
      {s.kind === "ready" ? (
        <span className="line-ok" title="Reads">
          <Check size={14} aria-label="Reads" />
        </span>
      ) : s.kind === "attention" ? (
        <span className="line-attention" title={s.reason}>
          <AlertTriangle size={14} aria-hidden /> {s.reason}
        </span>
      ) : (
        <span className="line-left-out">{leftOutText(line)}</span>
      )}
      {(includable || line.included) && (
        <label className="checkbox-label line-include">
          <input type="checkbox" checked={!!line.included} disabled={busy} onChange={(e) => onInclude(e.target.checked)} />
          Include
        </label>
      )}
      {onHeader && (
        <button className="link-button" disabled={busy} onClick={onHeader}>
          Use as header row
        </button>
      )}
      {children}
      {(line.fixed || line.included) && (
        <button
          className="icon-button line-revert"
          disabled={busy}
          title={assisted ? "Fixed by the assistant · put back as the file has it" : "Put back as the file has it"}
          aria-label={`Put line ${line.id} back as the file has it`}
          onClick={onRevert}
        >
          {assisted ? <Sparkles size={13} aria-hidden /> : null}
          <RotateCcw size={13} aria-hidden />
        </button>
      )}
    </span>
  );
}

/** A cell being edited: Enter or leaving it keeps the value, Escape doesn't. */
function CellInput({ value, onDone }: { value: string; onDone: (to: string | null) => void }) {
  const [text, setText] = useState(value);
  // Enter, then the blur as the input goes: once.
  const done = useRef(false);
  const finish = (to: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(to);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") finish(text);
    if (e.key === "Escape") finish(null);
  };
  return <input autoFocus aria-label="Cell" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} onBlur={() => finish(text)} />;
}
