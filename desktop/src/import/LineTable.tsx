import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { AlertTriangle, Check, CircleMinus, CirclePlus, Layers, Pencil, RotateCcw, Rows3, Sparkles, Split } from "lucide-react";
import type { BatchInfo, Statement, StatementLine } from "../bridge";
import { formatDate, money } from "../format";
import type { BankColumns } from "../types";
import { useVirtualRows } from "../ui";
import { textWidth, useColumns } from "../ui/columns";
import { FIELDS, INCLUDABLE, ROLES, leftOutText } from "./model";

/** A line is this tall, so a long file only renders the lines in view (as the register's rows). */
const LINE = 34;
/** The line being edited: its fields (40px under 4px of padding), its footer (48px) and its edge. */
const EDIT = 4 + 40 + 48 + 1;
/** The column of what can be done to each line. */
const ACTIONS = 116;

/** What can be done to a line, the same functions for every render. */
export type LineOps = {
  /** Cells given new values, each against the line as it reads when the change is made. */
  cells: (line: StatementLine, changes: { column: number; to: string }[]) => void;
  include: (line: StatementLine, on: boolean) => void;
  revert: (line: StatementLine) => void;
  header: (line: StatementLine) => void;
  whole: (entry: string, on: boolean) => void;
  role: (column: number, role: keyof BankColumns | null) => void;
};
/** Cells given new values, shown as them until the file reads again. */
type Pending = { line: string; values: Record<number, string>; revision: number };

/**
 * The file's lines as the register lists transactions: a line is selected with a click and
 * edited with another (or Enter), all its cells at once in a row of fields, Enter saving and
 * Esc leaving it. What can be done to a line (fix it, include it, put it back) sits in a column
 * of its own on the right, quiet until the line is pointed at. The first column says how each
 * line imports, or why it doesn't.
 */
export function LineTable({
  statement,
  lines,
  role,
  busy,
  slow,
  assisted,
  ops,
  empty,
}: {
  statement: Statement;
  /** The lines the tab shows. */
  lines: StatementLine[];
  /** What each column holds, by its place. */
  role: (keyof BankColumns | null)[];
  /** A change is being applied: the cells given meanwhile show until the file reads again. */
  busy: boolean;
  /** One that lasts: the lines say so. */
  slow: boolean;
  assisted: ReadonlySet<string>;
  ops: LineOps;
  /** Shown when the tab has no lines. */
  empty: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ line: string; column: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const table = statement.format === "csv";
  const headers = statement.headers;
  const width = Math.max(1, headers.length);
  const place = useMemo(() => new Map(statement.lines.map((l, i) => [l.id, i])), [statement.lines]);
  // A new reading of the file shows the cells as they read; a change that didn't apply, as they were.
  useEffect(() => setPending((p) => (p && p.revision !== statement.revision ? null : p)), [statement.revision]);
  useEffect(() => {
    if (!busy) setPending((p) => (p && p.revision === statement.revision ? null : p));
  }, [busy]);
  // A line no longer in the tab isn't being edited.
  useEffect(() => {
    if (editing && !lines.some((l) => l.id === editing.line)) setEditing(null);
  }, [lines]);

  // Columns as wide as what they hold (each file's own), resizable as the register's.
  const fitted = useMemo(() => {
    const sample = statement.lines.slice(0, 300);
    return headers.map((h, i) => {
      let longest = "";
      for (const l of sample) if ((l.cells[i]?.length ?? 0) > longest.length) longest = l.cells[i];
      const head = textWidth((h || `Column ${i + 1}`).toUpperCase(), 11, 600) + (table ? 74 : 0);
      return Math.min(320, Math.max(84, Math.max(head, textWidth(longest, 13)) + 24));
    });
  }, [headers, statement.lines, table]);
  // Widths someone set are kept for files laid out the same way.
  const columns = useColumns(
    `import-lines:${layoutKey(headers)}`,
    Object.fromEntries([["state", 212], ...fitted.map((w, i) => [`c${i}`, w])]) as Record<string, number>,
    { state: 150 },
  );
  const tracks = [`${columns.widths.state}px`, ...fitted.map((_, i) => `${columns.widths[`c${i}`]}px`)];
  // The last column takes any room to spare, so the table fills the page.
  tracks[tracks.length - 1] = `minmax(${tracks[tracks.length - 1]}, 1fr)`;
  const style = {
    "--line-cols": [...tracks, `${ACTIONS}px`].join(" "),
    "--state-width": `${columns.widths.state}px`,
    minWidth: columns.widths.state + fitted.reduce((n, _, i) => n + columns.widths[`c${i}`], 0) + ACTIONS,
  } as CSSProperties;

  // Only the lines in view render; the line being edited is taller.
  const view = useVirtualRows(scroller, lines.length, LINE);
  const editAt = editing ? lines.findIndex((l) => l.id === editing.line) : -1;
  const extra = EDIT - LINE;
  const before = view.before + (editAt >= 0 && editAt < view.start ? extra : 0);
  const after = view.after + (editAt >= view.end ? extra : 0);

  // The handlers read the table as it is now, so the rows keep the same ones.
  const latest = useRef({ cursor });
  latest.current = { cursor };
  // A line can be edited while a change applies: what it saves waits for that change.
  const edit = useMemo(
    () => (line: StatementLine, column?: number) => {
      setCursor(line.id);
      // Where the line doesn't read, else where it was clicked, else its first cell.
      const bad = line.status.kind === "attention" && table ? line.status.column : undefined;
      setEditing({ line: line.id, column: column ?? bad ?? 0 });
    },
    [table],
  );
  const focusGrid = () => requestAnimationFrame(() => scroller.current?.focus({ preventScroll: true }));
  const close = () => {
    setEditing(null);
    focusGrid();
  };
  const save = (line: StatementLine, values: string[]) => {
    const changes = values.map((to, column) => ({ column, to: to.trim() })).filter((c) => c.to !== (line.cells[c.column] ?? "").trim());
    close();
    if (!changes.length) return;
    setPending({ line: line.id, values: Object.fromEntries(changes.map((c) => [c.column, c.to])), revision: statement.revision });
    ops.cells(line, changes);
  };
  const reveal = (index: number) => {
    const el = scroller.current;
    if (!el) return;
    // Under the sticky heading.
    const head = el.querySelector<HTMLElement>(".line-head")?.offsetHeight ?? LINE;
    const top = index * LINE + head;
    if (top - head < el.scrollTop) el.scrollTop = top - head;
    else if (top + LINE > el.scrollTop + el.clientHeight) el.scrollTop = top + LINE - el.clientHeight;
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, input, select, .line-editor")) return;
    const index = cursor ? lines.findIndex((l) => l.id === cursor) : -1;
    const move = (to: number) => {
      const next = lines[Math.min(lines.length - 1, Math.max(0, to))];
      if (!next) return;
      e.preventDefault();
      setCursor(next.id);
      reveal(lines.indexOf(next));
    };
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / LINE) - 2);
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index < 0 ? 0 : index - 1);
    else if (e.key === "PageDown") move(index + page);
    else if (e.key === "PageUp") move(index - page);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(lines.length - 1);
    else if ((e.key === "Enter" || e.key === "F2") && index >= 0) {
      e.preventDefault();
      edit(lines[index]);
    } else if (e.key === " " && index >= 0) {
      // Space includes a line left out, or leaves one out again.
      const line = lines[index];
      const includable = line.status.kind === "leftOut" && INCLUDABLE.has(line.status.reason);
      if (includable || line.included) {
        e.preventDefault();
        if (!slow) ops.include(line, !line.included);
      }
    } else if (e.key === "Escape" && cursor) {
      e.preventDefault();
      setCursor(null);
    }
  };
  const click = useMemo(
    () => (line: StatementLine) => (e: MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest("button, input, select, a")) return;
      const column = Number(target.closest<HTMLElement>("[data-column]")?.dataset.column ?? NaN);
      // A second click on the selected line edits it, starting in the clicked cell.
      if (latest.current.cursor === line.id) edit(line, Number.isNaN(column) ? undefined : column);
      else setCursor(line.id);
    },
    [edit],
  );
  return (
    <div className={`line-scroll${slow ? " slow" : ""}`} ref={scroller} tabIndex={0} onKeyDown={keys}>
      <div className="line-table" role="grid" aria-label="The file's lines" aria-rowcount={lines.length + 1} style={style}>
        <div className="line-row line-head" role="row">
          <span role="columnheader" className="line-state" title="How each line imports, or why it doesn't">
            Imports as
            {columns.grip("state", "Imports as")}
          </span>
          {headers.map((h, i) => (
            <span role="columnheader" key={i} className="line-col">
              <span className="line-col-name" title={h || `Column ${i + 1}`}>
                {h || `Column ${i + 1}`}
              </span>
              {table && <RolePick column={i} role={role[i] ?? null} busy={slow} onChange={(r) => ops.role(i, r)} />}
              {columns.grip(`c${i}`, h || `Column ${i + 1}`)}
            </span>
          ))}
          <span role="columnheader" className="line-actions-cell" aria-label="What can be done" />
        </div>
        {before > 0 && <div aria-hidden style={{ height: before }} />}
        {lines
          .slice(view.start, view.end)
          .map((line) =>
            editing?.line === line.id ? (
              <LineEditor
                key={line.id}
                line={line}
                headers={headers}
                locked={table ? role.map((r) => r === "id") : []}
                focus={editing.column}
                onSave={(values) => save(line, values)}
                onCancel={close}
              />
            ) : (
              <LineRow
                key={line.id}
                line={line}
                index={place.get(line.id) ?? -1}
                batch={line.batch !== undefined ? statement.batches?.[line.batch] : undefined}
                headers={headers}
                table={table}
                width={width}
                busy={slow}
                cursor={cursor === line.id}
                assisted={assisted.has(line.id)}
                pending={pending?.line === line.id ? pending.values : null}
                ops={ops}
                onClick={click}
                onEdit={edit}
              />
            ),
          )}
        {after > 0 && <div aria-hidden style={{ height: after }} />}
      </div>
      {!lines.length && <div className="line-empty">{empty}</div>}
    </div>
  );
}

/** A short name for a file's layout: its columns' names. */
function layoutKey(headers: string[]) {
  let hash = 0;
  for (const c of headers.join("")) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) | 0;
  return `${headers.length}-${(hash >>> 0).toString(36)}`;
}

/** What a column holds, chosen in its heading: a quiet chip over a menu. */
function RolePick({
  column,
  role,
  busy,
  onChange,
}: {
  column: number;
  role: keyof BankColumns | null;
  busy: boolean;
  onChange: (role: keyof BankColumns | null) => void;
}) {
  const label = ROLES.find(([r]) => r === role)?.[1];
  return (
    <label className={`role-pick${role ? " on" : ""}`} title="What this column holds">
      <span aria-hidden>{label ?? "Not read"}</span>
      <select
        aria-label={`What column ${column + 1} holds`}
        value={role ?? ""}
        disabled={busy}
        onChange={(e) => onChange((e.target.value || null) as keyof BankColumns | null)}
      >
        <option value="">Not read</option>
        {ROLES.map(([r, name]) => (
          <option key={r} value={r}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A line of the file. Redrawn only when what it shows changes. */
const LineRow = memo(function LineRow({
  line,
  index,
  batch,
  headers,
  table,
  width,
  busy,
  cursor,
  assisted,
  pending,
  ops,
  onClick,
  onEdit,
}: {
  line: StatementLine;
  /** Where it is among the file's lines, as a batch names its payments. */
  index: number;
  batch?: BatchInfo;
  headers: string[];
  table: boolean;
  width: number;
  busy: boolean;
  cursor: boolean;
  assisted: boolean;
  pending: Record<number, string> | null;
  ops: LineOps;
  onClick: (line: StatementLine) => (e: MouseEvent<HTMLDivElement>) => void;
  onEdit: (line: StatementLine, column?: number) => void;
}) {
  const s = line.status;
  const changed = !!(line.fixed || line.included);
  return (
    <div
      role="row"
      aria-selected={cursor}
      data-line={line.id}
      className={`line-row ${s.kind}${changed ? " changed" : ""}${cursor ? " cursor" : ""}`}
      onClick={onClick(line)}
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("button, input, select")) return;
        const column = Number(target.closest<HTMLElement>("[data-column]")?.dataset.column ?? NaN);
        onEdit(line, Number.isNaN(column) ? undefined : column);
      }}
    >
      <span role="cell" className="line-state">
        {s.kind === "ready" ? (
          <ReadsAs line={line} assisted={assisted} />
        ) : s.kind === "attention" ? (
          <span className="line-attention" title={s.reason}>
            <AlertTriangle size={14} aria-hidden />
            <span>{s.reason}</span>
          </span>
        ) : (
          <span className="line-left-out" title={leftOutText(line)}>
            {line.included ? "Included · " : ""}
            {leftOutText(line)}
          </span>
        )}
      </span>
      {Array.from({ length: width }, (_, column) => {
        const waiting = pending?.[column] ?? null;
        const value = waiting ?? line.cells[column] ?? "";
        const bad = waiting === null && s.kind === "attention" && (table ? s.column === column : FIELDS[s.field] === headers[column]);
        const edited = waiting !== null || (!!line.original?.length && (line.original[column] ?? "") !== value);
        return (
          <span
            role="cell"
            key={column}
            data-column={column}
            className={`line-cell${bad ? " bad" : ""}${edited ? " edited" : ""}${waiting !== null ? " waiting" : ""}`}
            aria-label={`${headers[column] || `Column ${column + 1}`} of line ${line.id}: ${value || "empty"}`}
            title={edited && line.original?.length ? `In the file: ${line.original[column] ?? ""}` : value}
          >
            {value}
          </span>
        );
      })}
      <span role="cell" className="line-actions-cell">
        <LineActions line={line} index={index} batch={batch} assisted={assisted} busy={busy} ops={ops} onEdit={onEdit} />
      </span>
    </div>
  );
});

/**
 * What can be done to a line, always in the same place: icons, which show their names when the
 * line is pointed at, selected or tabbed to (a line with one thing to do shows its name all along).
 */
function LineActions({
  line,
  index,
  batch,
  assisted,
  busy,
  ops,
  onEdit,
}: {
  line: StatementLine;
  index: number;
  batch?: BatchInfo;
  assisted: boolean;
  busy: boolean;
  ops: LineOps;
  onEdit: (line: StatementLine, column?: number) => void;
}) {
  const s = line.status;
  const id = line.id;
  // Each with a short label, and a name that says it all to whoever can't see the line.
  const list: { label: string; name: string; title: string; icon: ReactNode; run: () => void }[] = [];
  if (s.kind === "attention")
    list.push({ label: "Fix", name: `Fix line ${id}`, title: s.reason, icon: <Pencil size={13} />, run: () => onEdit(line) });
  if (s.kind === "leftOut" && INCLUDABLE.has(s.reason) && !line.included)
    list.push({
      label: "Include",
      name: `Include line ${id}`,
      title: "Import this line though it's left out",
      icon: <CirclePlus size={14} />,
      run: () => ops.include(line, true),
    });
  if (line.included)
    list.push({
      label: "Leave out",
      name: `Leave line ${id} out`,
      title: "Leave this line out again",
      icon: <CircleMinus size={14} />,
      run: () => ops.include(line, false),
    });
  if (s.kind === "leftOut" && s.reason === "aboveHeader")
    list.push({
      label: "Header",
      name: `Use line ${id} as the header row`,
      title: "Use this line as the header row: the columns take its names",
      icon: <Rows3 size={14} />,
      run: () => ops.header(line),
    });
  if (batch && batch.addsUp === false && !batch.asOne && batch.payments[0] === index)
    list.push({
      label: "As one",
      name: "Import as one entry",
      title: "Import the batch as the bank's one entry, not its payments",
      icon: <Layers size={14} />,
      run: () => ops.whole(batch.entry, true),
    });
  if (batch?.asOne && batch.line === index)
    list.push({
      label: "Split",
      name: "Import the payments one by one",
      title: "Import the batch's payments one by one",
      icon: <Split size={14} />,
      run: () => ops.whole(batch.entry, false),
    });
  if (line.fixed)
    list.push({
      label: "Undo",
      name: `Put line ${id} back as the file has it`,
      title: assisted ? "Fixed by the assistant · put back as the file has it" : "Put back as the file has it",
      icon: assisted ? <Sparkles size={13} /> : <RotateCcw size={13} />,
      run: () => ops.revert(line),
    });
  if (!list.length) return null;
  return (
    <span className={`line-actions${list.length === 1 ? " single" : ""}`}>
      {list.map((a) => (
        <button
          key={a.label}
          type="button"
          className="line-action"
          disabled={busy}
          title={a.title}
          aria-label={a.name}
          onClick={(e) => {
            e.stopPropagation();
            a.run();
          }}
        >
          {a.icon}
          <span className="line-action-label">{a.label}</span>
        </button>
      ))}
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

/**
 * A line being edited, as the register edits a transaction: every cell a field, Tab moving
 * through them, Enter saving and Esc leaving it as it was. A bank's ID isn't changed.
 */
function LineEditor({
  line,
  headers,
  locked,
  focus,
  onSave,
  onCancel,
}: {
  line: StatementLine;
  headers: string[];
  /** Columns that can't be changed (the bank's ID). */
  locked: boolean[];
  /** The cell to start in. */
  focus: number;
  onSave: (values: string[]) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(() => headers.map((_, i) => line.cells[i] ?? ""));
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = row.current;
    const input = el?.querySelectorAll<HTMLInputElement>("input")[focus];
    input?.focus({ preventScroll: true });
    input?.select();
    const scroller = el?.closest<HTMLElement>(".line-scroll");
    const cell = input?.parentElement;
    if (!el || !scroller || !cell) return;
    // The cell may be off to the side: brought into view between the pinned columns (how the
    // line imports, what can be done to it), and the whole line above the bottom edge.
    const left = el.querySelector<HTMLElement>(".line-state")?.offsetWidth ?? 0;
    if (cell.offsetLeft - left < scroller.scrollLeft) scroller.scrollLeft = cell.offsetLeft - left;
    else if (cell.offsetLeft + cell.offsetWidth > scroller.scrollLeft + scroller.clientWidth - ACTIONS)
      scroller.scrollLeft = cell.offsetLeft + cell.offsetWidth - scroller.clientWidth + ACTIONS;
    const bottom = el.offsetTop + el.offsetHeight;
    if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  }, []);
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSave(values);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };
  const problem = line.status.kind === "attention" ? line.status.reason : line.status.kind === "leftOut" ? leftOutText(line) : "";
  return (
    <div className="line-row line-editor" role="row" ref={row} onKeyDown={keys} aria-label={`Edit line ${line.id}`}>
      <span role="cell" className="line-state">
        <span className={problem ? "line-attention" : "line-editing"}>
          {problem ? <AlertTriangle size={14} aria-hidden /> : <Pencil size={13} aria-hidden />}
          <span>{problem || "Editing the line"}</span>
        </span>
      </span>
      {headers.map((h, i) => (
        <span role="cell" key={i} className="line-cell">
          <input
            aria-label={`${h || `Column ${i + 1}`} of line ${line.id}`}
            value={values[i]}
            readOnly={locked[i]}
            title={
              locked[i]
                ? "The bank's ID for the line isn't changed"
                : line.original?.length
                  ? `In the file: ${line.original[i] ?? ""}`
                  : undefined
            }
            onChange={(e) => setValues((v) => v.map((x, k) => (k === i ? e.target.value : x)))}
          />
        </span>
      ))}
      <span role="cell" className="line-actions-cell" />
      <div className="line-editor-footer">
        <span className="line-editor-buttons">
          <button type="button" className="primary small" onClick={() => onSave(values)}>
            Save
          </button>
          <button type="button" className="secondary small" onClick={onCancel}>
            Cancel
          </button>
          <span className="editor-hint" aria-hidden>
            <kbd>Enter</kbd> saves · <kbd>Esc</kbd> cancels · <kbd>Tab</kbd> moves to the next cell
          </span>
        </span>
      </div>
    </div>
  );
}
