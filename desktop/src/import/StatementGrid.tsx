import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Check, LoaderCircle, MessageSquareText, RotateCcw, Sparkles } from "lucide-react";
import type { BankFixes, BankSession, BatchInfo, Statement, StatementLine } from "../bridge";
import type { BankColumns } from "../types";
import { formatDate, money } from "../format";
import { Tabs, useVirtualRows } from "../ui";
import { useSteady } from "../useSteady";
import { FIELDS, INCLUDABLE, ROLES, fixesFor, leftOutText, readings, restructure, roles, shown, withRole, type Filter } from "./model";

/** Each line is this tall, so a long file only renders the lines in view. */
const LINE = 37;

/** What a line can have done to it, the same functions for every render. */
type LineActions = {
  edit: (line: string, column: number) => void;
  commit: (line: StatementLine, column: number, to: string | null) => void;
  include: (line: StatementLine, on: boolean) => void;
  revert: (line: StatementLine) => void;
  header: (line: StatementLine) => void;
  whole: (entry: string, on: boolean) => void;
};
/** A change to the import, made against it as it is when it's made. */
type Build = (session: BankSession, statement: Statement) => BankFixes;
/** A cell given a new value, shown as it until the file reads again. */
type Pending = { line: string; column: number; to: string; revision: number };

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
  checking = false,
}: {
  statement: Statement;
  session: BankSession;
  /** A change is being applied, or the file read again: nothing else is changed meanwhile. */
  busy: boolean;
  /** Lines the assistant changed. */
  assisted: ReadonlySet<string>;
  onFix: (fixes: BankFixes) => void;
  onContinue: () => void;
  /** Hands the lines that need attention to the assistant. */
  onAssistant?: () => void;
  /** On to the review: its lines are being checked against the budget. */
  checking?: boolean;
}) {
  // Most changes take a moment: the grid only looks busy (dimmed, with a progress line) for one
  // that lasts, so a quick one doesn't flash it.
  const slow = useSteady(busy, (b) => b, 300);
  const [filter, setFilter] = useState<Filter>(statement.counts.attention ? "attention" : "all");
  const [editing, setEditing] = useState<{
    line: string;
    column: number;
  } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => statement.lines.filter((l) => shown(l, filter)), [statement.lines, filter]);
  const place = useMemo(() => new Map(statement.lines.map((l, i) => [l.id, i])), [statement.lines]);
  // Each tab's count, once per reading of the file rather than on every scroll.
  const counts = useMemo(() => {
    let leftOut = 0;
    let edited = 0;
    for (const l of statement.lines) {
      if (l.status.kind === "leftOut") leftOut++;
      if (l.fixed || l.included) edited++;
    }
    return {
      all: statement.lines.length,
      attention: statement.counts.attention,
      leftOut,
      edited,
    };
  }, [statement]);
  const view = useVirtualRows(scroller, lines.length, LINE);
  const table = statement.format === "csv";
  const role = useMemo(() => (table ? roles(statement.headers, statement.columns) : []), [table, statement.headers, statement.columns]);
  const s = session.structure;

  // The handlers read the session as it is now, so the rows keep the same ones and only redraw
  // when what they show changes. A change asked for while another applies waits for it, then is
  // made against the import as it is then (the latest one asked for, if several were).
  const latest = useRef({ session, statement, onFix, busy });
  latest.current = { session, statement, onFix, busy };
  const queued = useRef<Build | null>(null);
  const actions = useMemo<LineActions & { send: (build: Build) => void }>(() => {
    const send = (build: Build) => {
      const now = latest.current;
      if (now.busy) queued.current = build;
      else now.onFix(build(now.session, now.statement));
    };
    // A line's change, against the line as it reads when it's made.
    const onLine = (line: StatementLine, change: (l: StatementLine) => Parameters<typeof fixesFor>[1]) =>
      send((now, st) => fixesFor(now, change(st.lines.find((l) => l.id === line.id) ?? line)));
    return {
      send,
      edit: (line, column) => setEditing({ line, column }),
      commit: (line, column, to) => {
        setEditing(null);
        if (to === null || to.trim() === line.cells[column]?.trim()) return;
        setPending({ line: line.id, column, to: to.trim(), revision: latest.current.statement.revision });
        onLine(line, (l) => ({ cells: [{ line: l.id, lineVersion: l.version, column, from: l.cells[column] ?? "", to }] }));
      },
      include: (line, on) => onLine(line, (l) => ({ include: [{ line: l.id, lineVersion: l.version, include: on }] })),
      revert: (line) => onLine(line, (l) => ({ revert: [{ line: l.id, lineVersion: l.version }] })),
      header: (line) => send((now) => restructure(now, { headerLine: Number(line.id) })),
      whole: (entry, on) =>
        send((now) => {
          const was = now.structure.wholeBatches ?? [];
          return restructure(now, { wholeBatches: on ? [...was, entry] : was.filter((e) => e !== entry) });
        }),
    };
  }, []);
  useEffect(() => {
    if (busy || !queued.current) return;
    const build = queued.current;
    queued.current = null;
    onFix(build(session, statement));
  }, [busy]);
  // A new reading of the file shows the cell as it reads; one that failed shows it as it was.
  useEffect(() => setPending((p) => (p && p.revision !== statement.revision ? null : p)), [statement.revision]);
  useEffect(() => {
    if (!busy) setPending((p) => (p && p.revision === statement.revision && session.revision === statement.revision ? null : p));
  }, [busy, statement.revision, session.revision]);

  const act = actions.send;
  const asColumn = (column: number, value: string) =>
    act((now) =>
      restructure(now, {
        columns: withRole(statement.headers, statement.columns, column, (value || null) as keyof BankColumns | null),
      }),
    );
  const question = statement.dateOrder?.unconfirmed ? statement.dateOrder : null;
  const answered = statement.dateOrder && !statement.dateOrder.unconfirmed ? statement.dateOrder : null;
  const named = (question ?? answered) && readings((question ?? answered)!.example);
  // A file in another currency than the budget's: its lines are left out, each saying which.
  const foreign = useMemo(
    () => statement.lines.find((l) => l.status.kind === "leftOut" && l.status.reason === "otherCurrency")?.status,
    [statement.lines],
  );
  const elsewhere = !statement.counts.ready && foreign?.kind === "leftOut" ? foreign.detail : null;
  const attention = statement.counts.attention;
  const width = Math.max(1, statement.headers.length);
  const sources = statement.sources ?? [];
  const order = (o: "dmy" | "mdy") => act((now) => restructure(now, { dateOrder: { order: o, confirmed: true } }));
  return (
    <div className={`statement-editor${slow ? " slow" : ""}`}>
      <div className="statement-bar">
        {sources.length > 1 && (
          <label className="statement-source">
            Account in the file
            <select
              value={statement.source ?? 0}
              disabled={slow}
              onChange={(e) => {
                const source = sources[Number(e.target.value)].label;
                act((now) => restructure(now, { source }));
              }}
            >
              {sources.map((source, i) => (
                <option key={source.label} value={i}>
                  {source.label}
                  {source.currency ? ` · ${source.currency}` : ""} · {source.lines} {source.lines === 1 ? "line" : "lines"}
                </option>
              ))}
            </select>
          </label>
        )}
        {answered && (
          // Answered once, the date order stays one choice away.
          <label className="statement-choice">
            Dates
            <select value={answered.order} disabled={slow} onChange={(e) => order(e.target.value as "dmy" | "mdy")}>
              <option value="dmy">Day first{named ? ` (${answered.example} is ${named.dmy})` : ""}</option>
              <option value="mdy">
                Month first
                {named ? ` (${answered.example} is ${named.mdy})` : ""}
              </option>
            </select>
          </label>
        )}
        {statement.signs && !statement.signs.unconfirmed && (
          <label className="statement-choice">
            Money out
            <select
              value={statement.signs.byType ? "type" : "written"}
              disabled={slow}
              onChange={(e) => {
                const signsByType = e.target.value === "type";
                act((now) => restructure(now, { signsByType }));
              }}
            >
              <option value="type">Told by the transaction types</option>
              <option value="written">As the amounts are written</option>
            </select>
          </label>
        )}
        {table && (
          // Some card issuers write a purchase as a positive number and a payment as a negative one.
          <label
            className="statement-choice"
            title="How the file writes a purchase. Card statements often write purchases as positive numbers and payments as negative ones; choosing that turns every amount's sign."
          >
            Purchases in the file
            <select
              value={s.flipSigns ? "positive" : "negative"}
              disabled={slow}
              onChange={(e) => {
                // Read as chosen now: the change may wait for one before it.
                const flipSigns = e.target.value === "positive";
                act((now) => restructure(now, { flipSigns }));
              }}
            >
              <option value="negative">Negative, as bank accounts write them</option>
              <option value="positive">Positive, as many card statements write them</option>
            </select>
          </label>
        )}
      </div>
      {elsewhere && !statement.currency && (
        <p className="statement-question" role="status">
          <AlertTriangle size={15} aria-hidden />
          <span>
            The file's amounts are in {elsewhere}. Include a line to enter its amount in your budget's currency, or import the file into a
            budget in {elsewhere}.
          </span>
        </p>
      )}
      {statement.currency && (
        <p className="statement-question" role="status">
          <AlertTriangle size={15} aria-hidden />
          <span>
            This account's amounts are in {statement.currency}. Choose another account in the file, or include its lines with their amounts
            in your budget's currency.
          </span>
        </p>
      )}
      {question && (
        <div className="statement-question" role="group" aria-label="Date order">
          <AlertTriangle size={15} aria-hidden />
          <span>
            The dates don't say whether the day or the month comes first: is <b>{question.example}</b>
          </span>
          <span className="statement-answers">
            {(["dmy", "mdy"] as const).map((o) => (
              <button
                key={o}
                className={question.order === o ? "primary small" : "secondary small"}
                disabled={slow}
                onClick={() => order(o)}
              >
                {named ? named[o] : o === "dmy" ? "Day first" : "Month first"}
              </button>
            ))}
          </span>
        </div>
      )}
      {statement.signs?.unconfirmed && (
        <div className="statement-question" role="group" aria-label="Signs">
          <AlertTriangle size={15} aria-hidden />
          <span>Every amount that reads is positive. Is money out told by the transaction types (DEBIT, POS…)?</span>
          <span className="statement-answers">
            <button className="primary small" disabled={slow} onClick={() => act((now) => restructure(now, { signsByType: true }))}>
              Yes, use the types
            </button>
            <button className="secondary small" disabled={slow} onClick={() => act((now) => restructure(now, { signsByType: false }))}>
              No, as written
            </button>
          </span>
        </div>
      )}
      <Tabs
        label="Show lines"
        value={filter}
        onChange={setFilter}
        tabs={[
          { id: "all", label: "All", count: counts.all },
          { id: "attention", label: "Need attention", count: counts.attention },
          { id: "leftOut", label: "Left out", count: counts.leftOut },
          { id: "edited", label: "Edited", count: counts.edited },
        ]}
      />
      <div className="statement-grid-frame">
        {/* A change that takes a while shows as a line moving along the top, not a dimmed grid. */}
        <div className="statement-progress" aria-hidden />
        <div className="table-scroll statement-grid" ref={scroller}>
          <table>
            <thead>
              {table && (
                <tr className="statement-roles">
                  <th />
                  {statement.headers.map((_, i) => (
                    <th key={i}>
                      <select
                        aria-label={`What column ${i + 1} holds`}
                        value={role[i] ?? ""}
                        disabled={slow}
                        onChange={(e) => asColumn(i, e.target.value)}
                      >
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
                <th className="statement-state" title="What each line imports as, or why it doesn't">
                  Imports as
                </th>
                {statement.headers.map((h, i) => (
                  <th key={i}>{h || `Column ${i + 1}`}</th>
                ))}
              </tr>
            </thead>
            {/* Another tab's lines come in softly rather than snapping in. */}
          <tbody key={filter} className="statement-rows">
              {view.before > 0 && (
                <tr aria-hidden className="spacer-row" style={{ height: view.before }}>
                  <td colSpan={width + 1} />
                </tr>
              )}
              {lines.slice(view.start, view.end).map((line) => (
                <StatementRow
                  key={line.id}
                  line={line}
                  index={place.get(line.id) ?? -1}
                  batch={line.batch !== undefined ? statement.batches?.[line.batch] : undefined}
                  headers={statement.headers}
                  role={role}
                  table={table}
                  width={width}
                  busy={slow}
                  assisted={assisted.has(line.id)}
                  editing={editing?.line === line.id ? editing.column : null}
                  pending={pending?.line === line.id ? pending : null}
                  actions={actions}
                />
              ))}
              {view.after > 0 && (
                <tr aria-hidden className="spacer-row" style={{ height: view.after }}>
                  <td colSpan={width + 1} />
                </tr>
              )}
            </tbody>
          </table>
          {!lines.length && (
            <p className="help statement-empty">
              {filter === "attention" ? "Every line reads now. " : filter === "edited" ? "Nothing changed yet. " : "No lines here. "}
              <button className="link-button" onClick={() => setFilter("all")}>
                Show all lines
              </button>
            </p>
          )}
        </div>
      </div>
      <div className="form-actions statement-actions">
        <span className="help" role="status">
          {checking
            ? "Checking the lines against your budget…"
            : question
              ? "Say whether the day or the month comes first, above, to continue."
              : statement.signs?.unconfirmed
                ? "Say how the file tells money out, above, to continue."
                : !statement.counts.ready
                  ? "No line reads yet."
                  : `${statement.counts.ready} ${statement.counts.ready === 1 ? "line reads" : "lines read"}${
                      attention > 0 ? ` · ${attention} ${attention === 1 ? "needs" : "need"} attention and won't be imported` : ""
                    }`}
        </span>
        {onAssistant && attention > 0 && (
          <button className="secondary" disabled={slow} onClick={onAssistant}>
            <MessageSquareText size={14} /> Fix with the assistant
          </button>
        )}
        <button
          className="primary"
          // Nothing goes on to the review on a guess the file leaves open.
          disabled={busy || checking || !statement.counts.ready || !!question || !!statement.signs?.unconfirmed}
          onClick={onContinue}
        >
          {checking && <LoaderCircle size={14} className="spin" aria-hidden />}
          Continue to the review
        </button>
      </div>
    </div>
  );
}

/** A line of the file: what became of it, and its cells to fix. Redrawn only when what it shows changes. */
const StatementRow = memo(function StatementRow({
  line,
  index,
  batch,
  headers,
  role,
  table,
  width,
  busy,
  assisted,
  editing,
  pending,
  actions,
}: {
  line: StatementLine;
  /** Where it is in the file's lines, as a batch names its payments. */
  index: number;
  batch?: BatchInfo;
  headers: string[];
  role: (keyof BankColumns | null)[];
  table: boolean;
  width: number;
  busy: boolean;
  assisted: boolean;
  editing: number | null;
  pending: Pending | null;
  actions: LineActions;
}) {
  const kind = line.status.kind;
  return (
    <tr className={`statement-line ${kind}`} data-line={line.id}>
      <td className="statement-state">
        <LineState
          line={line}
          assisted={assisted}
          busy={busy}
          onInclude={(on) => actions.include(line, on)}
          onRevert={() => actions.revert(line)}
          onHeader={
            table && line.status.kind === "leftOut" && line.status.reason === "aboveHeader" ? () => actions.header(line) : undefined
          }
        >
          {batch && batch.addsUp === false && !batch.asOne && batch.payments[0] === index && (
            <button className="link-button" disabled={busy} onClick={() => actions.whole(batch.entry, true)}>
              Import as one entry
            </button>
          )}
          {batch?.asOne && batch.line === index && (
            <button className="link-button" disabled={busy} onClick={() => actions.whole(batch.entry, false)}>
              Import its payments
            </button>
          )}
        </LineState>
      </td>
      {Array.from({ length: width }, (_, column) => {
        const waiting = pending?.column === column ? pending.to : null;
        const value = waiting ?? line.cells[column] ?? "";
        const bad =
          waiting === null &&
          line.status.kind === "attention" &&
          (table ? line.status.column === column : FIELDS[line.status.field] === headers[column]);
        const changed = waiting !== null || (!!line.original?.length && (line.original[column] ?? "") !== value);
        const locked = busy || (table && role[column] === "id");
        return (
          <td
            key={column}
            className={`statement-cell${bad ? " bad" : ""}${changed ? " changed" : ""}${waiting !== null ? " waiting" : ""}`}
            title={changed && line.original?.length ? `In the file: ${line.original[column] ?? ""}` : value}
            onDoubleClick={() => !locked && actions.edit(line.id, column)}
          >
            {editing === column ? (
              <CellInput value={value} onDone={(to) => actions.commit(line, column, to)} />
            ) : (
              <button
                type="button"
                className="statement-value"
                disabled={locked}
                aria-label={`${headers[column] || `Column ${column + 1}`} of line ${line.id}: ${value || "empty"}`}
                onClick={() => actions.edit(line.id, column)}
              >
                {value || " "}
              </button>
            )}
          </td>
        );
      })}
    </tr>
  );
});

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
        // How it imports, so a change to how the file reads (the signs, the date order, a column)
        // shows on every line it changes.
        <ReadsAs line={line} assisted={assisted} />
      ) : s.kind === "attention" ? (
        <span className="line-attention" title={s.reason}>
          <AlertTriangle size={14} aria-hidden /> {s.reason}
        </span>
      ) : (
        <span className="line-left-out" title={leftOutText(line)}>
          {leftOutText(line)}
        </span>
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

/** A line that reads: its date and amount as they import, lit up briefly when a change alters them. */
function ReadsAs({ line, assisted }: { line: StatementLine; assisted: boolean }) {
  const cents = Math.round(Number(line.fields.amount) * 100);
  const changed = line.fixed || line.included;
  const why = changed ? (assisted ? "Fixed by the assistant · " : line.included ? "Included · " : "Changed · ") : "";
  const amount = Number.isFinite(cents) ? money(cents, { symbol: false }) : line.fields.amount;
  // A new reading of the same line (the signs turned, another date order): shown as it changes.
  const reading = `${line.fields.date}|${line.fields.amount}`;
  const was = useRef(reading);
  const [moved, setMoved] = useState(0);
  useEffect(() => {
    if (was.current === reading) return;
    was.current = reading;
    setMoved((n) => n + 1);
  }, [reading]);
  return (
    <span className={`line-ok${changed ? " line-changed" : ""}`} title={`${why}Imports as ${formatDate(line.fields.date)}, ${amount}`}>
      <Check size={14} aria-label="Reads" />
      <span key={moved} className={`line-reading${moved ? " moved" : ""}`}>
        <span className="line-date">{formatDate(line.fields.date)}</span>
        <span className={`line-amount${cents > 0 ? " in" : ""}`}>{amount}</span>
      </span>
    </span>
  );
}

/** A cell being edited: Enter or leaving it keeps the value, Escape doesn't. */
function CellInput({ value, onDone }: { value: string; onDone: (to: string | null) => void }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  // The cell was clicked where it is: focusing it mustn't scroll the grid sideways under the
  // line's state.
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
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
  return (
    <input
      ref={input}
      aria-label="Cell"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={key}
      onBlur={() => finish(text)}
    />
  );
}
