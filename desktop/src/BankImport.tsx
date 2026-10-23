import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Download, FileText, FileUp, MessageSquareText, X } from "lucide-react";
import { api, type BankFileLayout, type BankRow } from "./bridge";
import { placeholder } from "./bankNames";
import { errorText, formatDate, money } from "./format";
import { today, type BankColumns, type BankFileSettings, type Budget } from "./types";
import { useToast, useVirtualRows } from "./ui";
import "./import.css";

/** Each review row is this tall, so a long bank file only renders the rows in view. */
const REVIEW_ROW = 41;
const FORMATS: Record<string, string> = { csv: "CSV or Excel", ofx: "OFX", qfx: "QFX", qif: "QIF", camt053: "CAMT.053", mt940: "MT940" };
/**
 * Extensions that aren't a format's own name: ISO 20022 statements are XML, MT940 has several, and a
 * workbook's sheet (or a ZIP's statements, whose content then says what they are) reads as a table.
 */
const EXTENSIONS: Record<string, string> = {
  xml: "camt053",
  sta: "mt940",
  "940": "mt940",
  mt940: "mt940",
  xlsx: "csv",
  xlsm: "csv",
  xlsb: "csv",
  xls: "csv",
  ods: "csv",
  zip: "csv",
};
const DATE_ORDERS: [string, string][] = [
  ["ymd", "Year-month-day (2026-10-31)"],
  ["dmy", "Day/month/year (31/10/2026)"],
  ["mdy", "Month/day/year (10/31/2026)"],
];
/**
 * A statement's text: UTF-16 or UTF-8 as its byte-order mark says, else UTF-8, else what the engine
 * makes of its bytes: a workbook's sheet as CSV, a ZIP of statements, or text in the encoding its
 * bytes fit (Windows-1250 or -1252 in Europe, Shift_JIS, GBK, Windows-1251…). A PDF it turns away.
 */
export async function statementText(file: Blob) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decode = (encoding: string, from = 0) => new TextDecoder(encoding).decode(bytes.subarray(from));
  // The engine gets the bytes as ISO-8859-1, a character for each.
  const engine = async () => {
    let latin1 = "";
    for (let i = 0; i < bytes.length; i += 0x8000) latin1 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return (await api.decodeStatement(latin1)).text;
  };
  // An Excel or OpenDocument workbook, a ZIP, a PDF: not text at all.
  const starts = (...signature: number[]) => signature.every((b, i) => bytes[i] === b);
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0xd0, 0xcf, 0x11, 0xe0) || starts(0x25, 0x50, 0x44, 0x46)) return engine();
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decode("utf-16le", 2);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decode("utf-16be", 2);
  // UTF-16 without a mark: plain text has a zero in every other byte.
  const head = bytes.subarray(0, 400);
  const zeros = (odd: number) => head.filter((b, i) => i % 2 === odd && b === 0).length;
  if (head.length >= 4 && zeros(1) > head.length / 4) return decode("utf-16le");
  if (head.length >= 4 && zeros(0) > head.length / 4) return decode("utf-16be");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return engine();
  }
}

/**
 * A row's choice lists at most this many possible matches, the nearest in date: an account with
 * thousands of the same charge would otherwise give every row thousands of options to draw.
 */
const LISTED = 50;
/** Columns an import can read: a date, and an amount or money out and in. */
const complete = (c: BankColumns) => !!c.date && !!(c.amount || c.outflow || c.inflow);
const PARTS: [keyof BankColumns, string][] = [
  ["date", "Date"],
  ["payee", "Payee"],
  ["memo", "Memo"],
  ["amount", "Amount"],
  ["outflow", "Money out"],
  ["inflow", "Money in"],
];

/** A CSV to start from: the headers the importer reads and a few example rows. */
export function bankTemplate(dateOrder = "ymd", month = today().slice(0, 7)) {
  const [y, m] = month.split("-");
  const date = (d: string) => (dateOrder === "dmy" ? `${d}/${m}/${y}` : dateOrder === "mdy" ? `${m}/${d}/${y}` : `${y}-${m}-${d}`);
  return [
    "Date,Payee,Memo,Outflow,Inflow",
    `${date("01")},Employer,Salary,,5000.00`,
    `${date("03")},Grocery store,Weekly shop,85.40,`,
    `${date("05")},Electric company,Monthly bill,120.00,`,
    "",
  ].join("\r\n");
}

/** What the assistant is asked when someone wants help with a file: ready to send, not sent. */
export function importHelpText(account: string, problem = "") {
  return [
    `Help me import this file into ${account}.`,
    problem && `The import preview said: ${problem}`,
    "Find the transactions, ask me about anything unclear, and prepare them for the import review.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** New transactions an import left without a category, and the accounts they went into. */
export type Uncategorized = { ids: string[]; accounts: string[] };
/** The assistant reads at most this many attached transactions at a time. */
export const ATTACH_LIMIT = 200;

/**
 * The transactions in `after` that weren't in `before` and still have no category: none at all,
 * or the Uncategorized placeholder. Payee rules may have categorized the rest. Tracking accounts
 * don't use categories, and transfers don't need one.
 */
export function uncategorizedImports(before: Budget, after: Budget): Uncategorized {
  const known = new Set(before.transactions.map((t) => t.id));
  const budgeted = new Set(after.accounts.filter((a) => a.kind !== "tracking" && a.onBudget !== false).map((a) => a.id));
  const fresh = after.transactions.filter(
    (t) =>
      !known.has(t.id) &&
      budgeted.has(t.accountId) &&
      !t.transferAccountId &&
      t.splits.every((s) => !s.transferAccountId && (!s.categoryId || placeholder(after, s.categoryId))),
  );
  const accounts = [...new Set(fresh.map((t) => t.accountId))].map((id) => after.accounts.find((a) => a.id === id)!.name);
  return { ids: fresh.map((t) => t.id), accounts };
}
const join = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
/** What the assistant is asked about them, ready to send with them attached; never sent by itself. */
export function categorizeText({ ids, accounts }: Uncategorized) {
  const where = join(accounts);
  if (ids.length > ATTACH_LIMIT) return `Categorize these ${ATTACH_LIMIT} of the ${ids.length} new transactions in ${where}.`;
  return ids.length === 1
    ? `Categorize the new transaction in ${where}.`
    : `Categorize the ${ids.length} new transactions in ${where}.`;
}

/**
 * Imports a file a bank exported: choose (or drop) the file, preview it, decide what each row
 * does (add, match an existing transaction, or skip), then import. Nothing is saved until then.
 */
export function BankImport({
  budget,
  transform,
  initialAccount,
  initialFile,
  embedded = false,
  onImported,
  onAskAssistant,
  onCategorize,
}: {
  /** A file to preview right away, such as one the assistant converted (CSV, ISO dates). */
  initialFile?: File;
  budget: Budget;
  transform: (work: (b: Budget) => Promise<Budget>) => Promise<void>;
  /** The account to import into; the dialog for one account doesn't ask again. */
  initialAccount?: string;
  /** Inside a dialog: no panel or heading of its own. */
  embedded?: boolean;
  /**
   * Called after a successful import with the number of rows added or matched, and the new
   * transactions that came in without a category.
   */
  onImported?: (count: number, uncategorized: Uncategorized) => void;
  /** Offers the assistant the new transactions that have no category, after an import here. */
  onCategorize?: (uncategorized: Uncategorized) => void;
  /**
   * Hands the chosen file to the assistant, with what went wrong if anything did. Offered all
   * along, and more prominently when the preview fails or doesn't look right.
   */
  onAskAssistant?: (file: File, problem: string, account: string) => void;
}) {
  const toast = useToast();
  const [account, setAccount] = useState(initialAccount ?? budget.accounts.find((a) => !a.archived)?.id ?? ""),
    [format, setFormat] = useState("csv"),
    [dateFormat, setDateFormat] = useState("ymd"),
    [flipSigns, setFlipSigns] = useState(false),
    [file, setFile] = useState<File | null>(initialFile ?? null),
    // A CSV's columns, and the ones chosen here (null: the account's saved choice, or the ones found by name).
    [layout, setLayout] = useState<BankFileLayout | null>(null),
    [chosen, setChosen] = useState<BankColumns | null>(null),
    [columnsOpen, setColumnsOpen] = useState(false),
    // The date order or signs were chosen for this file, so what the account kept doesn't replace them.
    touched = useRef(false),
    [dragging, setDragging] = useState(false),
    [rows, setRows] = useState<BankRow[]>([]),
    [base, setBase] = useState<Budget | null>(null),
    [message, setMessage] = useState(""),
    [left, setLeft] = useState<Uncategorized | null>(null),
    [busy, setBusy] = useState(false);
  // The last preview failed or found nothing, so the file needs another reading.
  const [failed, setFailed] = useState(false);
  const accountName = budget.accounts.find((a) => a.id === account)?.name ?? "";
  const kept = budget.accounts.find((a) => a.id === account)?.fileImport;
  // How the account's last file read, and a CSV's columns, as soon as the file is chosen.
  useEffect(() => {
    setLayout(null);
    setChosen(null);
    setColumnsOpen(false);
    if (format === "qif" && kept?.dateFormat) setDateFormat(kept.dateFormat);
    if (!file || format !== "csv" || !account) return;
    let live = true;
    statementText(file)
      .then((text) => api.bankFileColumns(budget, account, text))
      .then(
        (found) => {
          if (!live) return;
          // Not a CSV after all (an MT940 statement saved as .txt): read it as what it is.
          if (found.format && found.format !== "csv") return setFormat(found.format);
          setLayout(found);
          if (!touched.current) {
            if (found.dateFormat) setDateFormat(found.dateFormat);
            setFlipSigns(found.flipSigns);
          }
          setColumnsOpen(!complete(found.columns));
        },
        // The preview says what's wrong with a file this can't read.
        () => {},
      );
    return () => {
      live = false;
    };
  }, [file, account, format]);
  const reset = () => {
    setRows([]);
    setMessage("");
    setLeft(null);
    setFailed(false);
  };
  const choose = (next: File | null) => {
    touched.current = false;
    setFile(next);
    const ext = next?.name.split(".").pop()?.toLowerCase() ?? "";
    const known = ext in FORMATS ? ext : EXTENSIONS[ext];
    if (known) setFormat(known);
    reset();
  };
  const drop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) choose(dropped);
  };
  const template = async () => {
    try {
      const path = await api.writeExport("bank-import-template.csv", bankTemplate(dateFormat));
      toast({
        message: "Template saved.",
        action: { label: "Show in folder", onClick: () => void api.reveal(path).catch((e) => setMessage(errorText(e))) },
      });
    } catch (e) {
      setMessage(errorText(e));
    }
  };
  const preview = async () => {
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      const r = await api.previewBank(
        budget,
        account,
        await statementText(file),
        format,
        dateFormat,
        format === "csv" && flipSigns,
        format === "csv" ? chosen : null,
      );
      setRows(r);
      setBase(budget);
      if (!r.length) setMessage("The file has no transactions to import.");
      setFailed(!r.length);
    } catch (e) {
      setMessage(errorText(e));
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialFile) void preview();
  }, []);
  const save = async (choices: ImportChoice[], importing: number) => {
    setBusy(true);
    setMessage("");
    try {
      let uncategorized: Uncategorized = { ids: [], accounts: [] };
      await transform(async (b) => {
        if (b !== base) throw Error("Your budget changed. Preview the file again before importing.");
        // The account keeps how this file read for its next one.
        const remember: BankFileSettings | null =
          format === "csv"
            ? { dateFormat, flipSigns, ...(chosen ? { columns: chosen } : {}) }
            : format === "qif"
              ? { dateFormat }
              : null;
        const after = await api.importBank(b, account, choices, remember);
        uncategorized = uncategorizedImports(b, after);
        return after;
      });
      setRows([]);
      setFile(null);
      if (onImported) onImported(importing, uncategorized);
      else {
        setMessage(`Imported ${importing} ${importing === 1 ? "transaction" : "transactions"}. They're waiting for your approval.`);
        setLeft(uncategorized.ids.length ? uncategorized : null);
      }
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const Wrapper = embedded ? "div" : "section";
  // Every row as money in usually means the file writes purchases as positive numbers.
  const allIn = rows.length >= 3 && rows.every((r) => r.amount > 0);
  const problem = failed ? message : allIn ? "Every row came out as money in." : "";
  // A PDF is the assistant's to read.
  const pdf = !!file && /\.pdf$/i.test(file.name);
  return (
    <Wrapper className={`bank-import${embedded ? "" : " panel"}`}>
      {!embedded && <h2>Import a bank file</h2>}
      {!rows.length ? (
        <>
          <p className="import-lead">
            Bring in the transactions your bank exported. You check every row, and how it matches what you already
            entered, before anything is saved.
          </p>
          {!initialAccount && (
            <label className="import-account">
              Into account
              <select
                value={account}
                onChange={(e) => {
                  setAccount(e.target.value);
                  reset();
                }}
              >
                {budget.accounts
                  .filter((a) => !a.archived)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label
            className={`file-drop${dragging ? " dragging" : ""}${file ? " chosen" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
          >
            {file ? <FileText size={22} aria-hidden /> : <FileUp size={22} aria-hidden />}
            <span>
              <strong>{file ? file.name : "Choose a file"}</strong>
              <small>
                {file
                  ? `${pdf ? "PDF" : (FORMATS[format] ?? format.toUpperCase())} · ${Math.max(1, Math.round(file.size / 1024))} KB · click to choose another`
                  : "or drop it here · CSV, Excel, OFX, QFX, QIF, CAMT.053 or MT940, or a PDF through the assistant"}
              </small>
            </span>
            {file && (
              <button
                type="button"
                className="icon-button"
                aria-label="Remove the file"
                onClick={(e) => {
                  e.preventDefault();
                  choose(null);
                }}
              >
                <X size={15} />
              </button>
            )}
            <input
              type="file"
              className="sr-only"
              aria-label="Bank file"
              accept=".csv,.xlsx,.xls,.xlsm,.xlsb,.ods,.ofx,.qfx,.qif,.xml,.sta,.940,.mt940,.zip,.txt,.pdf"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                choose(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </label>
          {file && !pdf && (
            <div className="import-options">
              <label>
                Read as
                <select
                  value={format}
                  onChange={(e) => {
                    setFormat(e.target.value);
                    reset();
                  }}
                >
                  {Object.entries(FORMATS).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              {(format === "csv" || format === "qif") && (
                <label>
                  Dates in the file
                  <select
                    value={dateFormat}
                    onChange={(e) => {
                      touched.current = true;
                      setDateFormat(e.target.value);
                      reset();
                    }}
                  >
                    {DATE_ORDERS.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {format === "csv" && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={flipSigns}
                    onChange={(e) => {
                      touched.current = true;
                      setFlipSigns(e.target.checked);
                      reset();
                    }}
                  />
                  Purchases are positive
                </label>
              )}
            </div>
          )}
          {file && format === "csv" && layout && (
            <ColumnChoice
              layout={layout}
              columns={chosen ?? layout.columns}
              chosen={!!chosen}
              open={columnsOpen}
              onOpen={() => setColumnsOpen(true)}
              onChange={(columns) => {
                const dated = !!columns.date && columns.date !== (chosen ?? layout.columns).date;
                setChosen(columns);
                reset();
                // A date column just chosen says which order its dates are in.
                if (dated && !touched.current)
                  void statementText(file)
                    .then((text) => api.bankFileColumns(budget, account, text, columns))
                    .then(
                      (found) => {
                        if (found.dateFormat && !touched.current) setDateFormat(found.dateFormat);
                      },
                      () => {},
                    );
              }}
            />
          )}
          <div className="import-help">
            <p>
              In a <strong>CSV or Excel file</strong>, the <b>Date</b>, <b>Payee</b> and <b>Amount</b> (or money out and money
              in) columns are found by the names banks give them, in most languages, or by what's in them, or you can choose
              them; the account remembers them, and the date order, for its next file. If a card lists purchases as positive
              amounts, tick <b>Purchases are positive</b>. A <strong>PDF</strong> statement goes through the assistant.
            </p>
            <button type="button" className="secondary small" onClick={() => void template()}>
              <Download size={14} /> Download a template
            </button>
          </div>
          <div className="form-actions">
            <button
              className="primary"
              disabled={!file || pdf || busy || !account || (format === "csv" && !!layout && !complete(chosen ?? layout.columns))}
              onClick={() => void preview()}
            >
              {busy ? "Reading the file…" : "Preview transactions"}
            </button>
          </div>
        </>
      ) : (
        <ImportReview
          budget={budget}
          rows={rows}
          busy={busy}
          icon={<FileText size={18} aria-hidden />}
          title={
            <>
              <strong>{file?.name}</strong> into {accountName}
            </>
          }
          action={
            <button className="link-button" onClick={reset}>
              Change file
            </button>
          }
          onCancel={reset}
          onImport={(choices, count) => void save(choices, count)}
        />
      )}
      {message && (
        <p role="status" className="import-result">
          {message}
        </p>
      )}
      {onCategorize && left && (
        <CategorizeOffer
          uncategorized={left}
          onCategorize={() => {
            onCategorize(left);
            setLeft(null);
          }}
        />
      )}
      {onAskAssistant && file && (
        <div className={`import-assist${problem ? " needed" : ""}`}>
          <MessageSquareText size={16} aria-hidden />
          <p>
            {pdf
              ? "PDF statements need the assistant. It reads the PDF, finds the transactions, checks them against the statement's totals and brings them to this review, where you decide on each row."
              : failed
              ? "The assistant can read this file, find the transactions and ask you about anything unclear."
              : allIn
                ? "Every row came out as money in. If these are purchases, the signs are probably reversed, and the assistant can check the file with you."
                : rows.length
                  ? "If something here doesn't look right, the assistant can go through the file with you."
                  : "Not sure how this file will import? The assistant can read it and prepare it for you."}
            <small>Opens the assistant with this file attached. Nothing is sent until you press Send.</small>
          </p>
          <button
            type="button"
            className={problem || pdf ? "primary small" : "secondary small"}
            onClick={() => onAskAssistant(file, problem, accountName)}
          >
            {pdf ? "Read it with the assistant" : "Help with this import"}
          </button>
        </div>
      )}
      {!onAskAssistant && pdf && (
        <p role="status" className="import-result">
          PDF statements need the assistant, which isn't available here. Download a CSV, Excel, OFX, QIF, CAMT.053 or
          MT940 file from your bank instead.
        </p>
      )}
    </Wrapper>
  );
}

/**
 * Which of a CSV's columns hold what: a line saying what will be read, or a choice for each part
 * once opened, as it is when the columns' names weren't recognised.
 */
function ColumnChoice({
  layout,
  columns,
  chosen,
  open,
  onOpen,
  onChange,
}: {
  layout: BankFileLayout;
  columns: BankColumns;
  /** The columns were chosen here, not saved or found by name. */
  chosen: boolean;
  open: boolean;
  onOpen: () => void;
  onChange: (columns: BankColumns) => void;
}) {
  const [separate, setSeparate] = useState(!columns.amount && !!(columns.outflow || columns.inflow));
  // What the first rows have in a column, to tell them apart.
  const sample = (name?: string | null) => {
    const i = name ? layout.headers.indexOf(name) : -1;
    return i < 0 ? "" : (layout.samples.find((r) => r[i])?.[i] ?? "");
  };
  const reading = PARTS.filter(([part]) => columns[part]);
  if (!open)
    return (
      <div className="column-choice">
        <p>
          {layout.saved && !chosen ? "Columns you chose for this account: " : "Reading "}
          {reading.map(([part, label], i) => (
            <span key={part}>
              {i > 0 && " · "}
              {label} from <b>{columns[part]}</b>
            </span>
          ))}
        </p>
        <button type="button" className="link-button" onClick={onOpen}>
          Change columns
        </button>
      </div>
    );
  const field = (part: keyof BankColumns, label: string) => (
    <label key={part}>
      {label}
      <select
        aria-label={`${label} column`}
        value={columns[part] ?? ""}
        onChange={(e) => onChange({ ...columns, [part]: e.target.value || null })}
      >
        <option value="">{part === "date" || part === "amount" ? "Choose a column" : "None"}</option>
        {layout.headers.map(
          (h, i) =>
            h && (
              <option key={i} value={h}>
                {h}
              </option>
            ),
        )}
      </select>
      <small className="column-sample">{sample(columns[part]) || "\u00a0"}</small>
    </label>
  );
  return (
    <fieldset className="column-choice open">
      <legend>Columns</legend>
      <p className="help">
        {complete(columns)
          ? "Choose which column holds each part. The account keeps your choice for its next file."
          : "Choose the column with each transaction's date, and the one with its amount (or the ones with money out and money in). The account keeps your choice for its next file."}
      </p>
      <div className="import-options">
        {field("date", "Date")}
        {field("payee", "Payee")}
        {field("memo", "Memo")}
        <label>
          Amounts
          <select
            value={separate ? "separate" : "one"}
            onChange={(e) => {
              const next = e.target.value === "separate";
              setSeparate(next);
              onChange(next ? { ...columns, amount: null } : { ...columns, outflow: null, inflow: null });
            }}
          >
            <option value="one">In one column</option>
            <option value="separate">Money out and in apart</option>
          </select>
        </label>
        {separate ? (
          <>
            {field("outflow", "Money out")}
            {field("inflow", "Money in")}
          </>
        ) : (
          field("amount", "Amount")
        )}
      </div>
    </fieldset>
  );
}

export type ImportChoice = { row: BankRow; action: string; matchId: string | null };

/**
 * Skip known bank IDs and take a single match only when that account side has not been imported.
 * A transfer the bank text doesn't back up is only suggested: amount and date alone can't tell it
 * from a card payment of the same sum.
 */
const defaultChoice = (r: BankRow) => {
  if (r.duplicate) return "skip";
  if (r.possibleDuplicate) return "review";
  if (!r.candidates.length) return "new";
  const [only] = r.candidates;
  if (r.candidates.length > 1 || r.previouslyMatchedCandidates?.includes(only)) return "review";
  return r.transferCandidates?.includes(only) && !r.transferSure ? "review" : `match:${only}`;
};

/**
 * The review of transactions bound for one account, from a bank file or from bank sync: what
 * each row does (add it, match an existing transaction, or skip it), then one import.
 */
export function ImportReview({
  budget,
  rows,
  busy,
  icon,
  title,
  action,
  cancelLabel = "Cancel",
  onCancel,
  onImport,
}: {
  budget: Budget;
  rows: BankRow[];
  busy: boolean;
  icon: ReactNode;
  /** Where the rows come from and where they go. */
  title: ReactNode;
  /** A link beside the summary, such as one to choose another file. */
  action?: ReactNode;
  cancelLabel?: string;
  onCancel: () => void;
  /** Every row's choice, and how many rows are added or matched. */
  onImport: (choices: ImportChoice[], count: number) => void;
}) {
  // Rows checked again (bank sync does when the budget changes) keep the choices made so far.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const separateIds = useRef(new Map<string, string>());
  const choice = (r: BankRow) => {
    if (r.duplicate) return r.idless && choices[r.id] === "separate" ? "separate" : "skip";
    const selected = choices[r.id];
    if (selected?.startsWith("match:") && !r.candidates.includes(selected.slice(6))) return "review";
    return selected ?? defaultChoice(r);
  };
  const review = useRef<HTMLDivElement>(null);
  const inView = useVirtualRows(review, rows.length, REVIEW_ROW);
  const byId = useMemo(() => new Map(budget.transactions.map((t) => [t.id, t])), [budget.transactions]);
  const accountNames = useMemo(() => new Map(budget.accounts.map((a) => [a.id, a.name])), [budget.accounts]);
  // The nearest possible matches by date, worked out once for each list and day (rows share lists).
  const nearest = useMemo(() => new WeakMap<string[], Map<string, string[]>>(), [byId]);
  const listed = (r: BankRow) => {
    if (r.candidates.length <= LISTED) return r.candidates;
    let byDay = nearest.get(r.candidates);
    if (!byDay) nearest.set(r.candidates, (byDay = new Map()));
    let list = byDay.get(r.date);
    if (!list) {
      const legs = new Map(r.candidateDetails?.map((c) => [c.id, c.transactionId]));
      const day = Date.parse(r.date);
      const apart = (id: string) => {
        const t = byId.get(legs.get(id) ?? id);
        return t ? Math.abs(Date.parse(t.date) - day) : Infinity;
      };
      list = r.candidates
        .map((id) => [apart(id), id] as const)
        .sort((a, b) => a[0] - b[0])
        .slice(0, LISTED)
        .map(([, id]) => id);
      byDay.set(r.date, list);
    }
    const chosen = choice(r).startsWith("match:") ? choice(r).slice(6) : null;
    return chosen && !list.includes(chosen) ? [...list, chosen] : list;
  };
  const transfer = (r: BankRow, c: string) => c.startsWith("match:") && !!r.transferCandidates?.includes(c.slice(6));
  const importing = rows.filter((r) => choice(r) !== "skip").length;
  const transfers = rows.filter((r) => transfer(r, choice(r))).length;
  // Every row still to decide, the same way.
  const decide = (to: string) =>
    setChoices({ ...choices, ...Object.fromEntries(rows.filter((r) => choice(r) === "review").map((r) => [r.id, to])) });
  // Rows still to decide whose transfer is only suggested.
  const suggested = rows.filter((r) => choice(r) === "review" && r.transferCandidates?.length);
  const undecided = rows.filter((r) => choice(r) === "review").length;
  const duplicates = rows.filter((r) => r.duplicate).length;
  const renamed = rows.filter((r) => !r.duplicate && r.rename).length;
  const chosen = () =>
    rows.map((row) => {
      const c = choice(row);
      if (c === "separate") {
        let importId = separateIds.current.get(row.id);
        if (!importId) {
          importId = `bank:manual:${crypto.randomUUID()}`;
          separateIds.current.set(row.id, importId);
        }
        return { row: { ...row, importId }, action: "new", matchId: null };
      }
      return { row, action: c.startsWith("match:") ? "match" : c, matchId: c.startsWith("match:") ? c.slice(6) : null };
    });
  return (
    <>
      <div className="import-summary">
        {icon}
        <span>
          {title} · {rows.length} {rows.length === 1 ? "row" : "rows"}
          {duplicates > 0 && ` · ${duplicates} already imported`}
          {renamed > 0 && ` · ${renamed} renamed by your payee rules`}
          {transfers > 0 && ` · ${transfers} ${transfers === 1 ? "transfer" : "transfers"} between your accounts`}
        </span>
        {action}
      </div>
      <p className="help import-note">
        Matching keeps your category and memo and marks the transaction cleared. Imported transactions wait for your
        approval.
      </p>
      {rows.some((r) => r.transferCandidates?.length) && (
        <p className="help import-note">
          A transfer joins a row to the uncategorized entry it mirrors in another account, so the money you moved isn't
          counted as spending or income. It's chosen for you when the bank's text names the other account or matches
          earlier transfers between them; otherwise it's suggested for you to check.
        </p>
      )}
      {rows.some((r) => r.possibleDuplicate || (r.idless && r.duplicate)) && <p className="help import-note">
        This file has no bank transaction IDs. A row may already be imported; compare its memo and amount.
        Skip it if it is the same payment, or add it separately if it is a different payment.
      </p>}
      <div className="table-scroll import-review" ref={review}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Payee</th>
              <th className="num">Amount</th>
              <th>What to do</th>
            </tr>
          </thead>
          <tbody>
            {inView.before > 0 && (
              <tr aria-hidden className="spacer-row" style={{ height: inView.before }}>
                <td colSpan={4} />
              </tr>
            )}
            {rows.slice(inView.start, inView.end).map((r, i) => {
              const index = inView.start + i;
              return (
                <tr key={`${r.id}:${index}`} className={r.duplicate ? "muted" : ""}>
                  <td>{formatDate(r.date)}</td>
                  <td title={r.rename ? `${r.rename}, from the bank's “${r.payee}”` : undefined}>
                    {r.rename ?? r.payee}
                    {r.rename && <small className="bank-text">{r.payee}</small>}
                    {r.memo && <small className="bank-text" title={r.memo}>{r.memo}</small>}
                  </td>
                  <td className="num">{money(r.amount)}</td>
                  <td>
                    {r.duplicate && !r.idless ? (
                      "Already imported · skipped"
                    ) : (
                      <select
                        aria-label={`Import action ${index + 1}`}
                        disabled={busy}
                        value={choice(r)}
                        onChange={(e) => setChoices({ ...choices, [r.id]: e.target.value })}
                      >
                        {!r.duplicate && (
                          <option value="review">
                            {r.possibleDuplicate
                              ? "May already be imported — choose"
                              : r.transferCandidates?.length
                                ? "Transfer suggested — check it and choose"
                                : "Choose a match or add it"}
                          </option>
                        )}
                        {r.duplicate
                          ? <option value="separate">Add as a separate transaction</option>
                          : <option value="new">Add as a new transaction</option>}
                        <option value="skip">{r.duplicate ? "Already imported — skip" : "Skip"}</option>
                        {(r.duplicate ? [] : listed(r)).map((id) => {
                          const detail = r.candidateDetails?.find((c) => c.id === id);
                          const t = byId.get(detail?.transactionId ?? id);
                          const part = detail && t?.splits[detail.splitIndex];
                          const other = r.transferCandidates?.includes(id) && t && accountNames.get(t.accountId);
                          return (
                            <option key={id} value={`match:${id}`}>
                              {other ? `Transfer ${r.amount > 0 ? "from" : "to"} ${other}: ` : "Match: "}
                              {t ? formatDate(t.date) : ""} · {t?.payee || "Transfer"}
                              {detail ? ` · Split ${detail.splitIndex + 1}` : ""}
                              {part?.memo || t?.memo ? ` · ${part?.memo || t?.memo}` : ""}
                              {r.previouslyMatchedCandidates?.includes(id) ? " · Previously imported" : ""}
                            </option>
                          );
                        })}
                        {!r.duplicate && r.candidates.length > LISTED && (
                          <option disabled>
                            {r.candidates.length - LISTED} more of the same amount within ten days aren't listed
                          </option>
                        )}
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
            {inView.after > 0 && (
              <tr aria-hidden className="spacer-row" style={{ height: inView.after }}>
                <td colSpan={4} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        {undecided > 0 && (
          <span className="help">
            {undecided} {undecided === 1 ? "row needs" : "rows need"} a choice
          </span>
        )}
        {suggested.length > 0 && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              setChoices({ ...choices, ...Object.fromEntries(suggested.map((r) => [r.id, `match:${r.transferCandidates![0]}`])) })
            }
          >
            Pair {suggested.length} suggested {suggested.length === 1 ? "transfer" : "transfers"}
          </button>
        )}
        {undecided > 0 && (
          <>
            <button className="secondary" disabled={busy} onClick={() => decide("new")}>
              Add {undecided === 1 ? "it" : "them"} as new
            </button>
            <button className="secondary" disabled={busy} onClick={() => decide("skip")}>
              Skip {undecided === 1 ? "it" : "them"}
            </button>
          </>
        )}
        <button className="secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button className="primary" disabled={busy || undecided > 0 || !importing} onClick={() => onImport(chosen(), importing)}>
          {busy ? "Importing…" : `Import ${importing} ${importing === 1 ? "transaction" : "transactions"}`}
        </button>
      </div>
    </>
  );
}

/** After an import: the new transactions without a category, offered to the assistant. */
export function CategorizeOffer({ uncategorized, onCategorize }: { uncategorized: Uncategorized; onCategorize: () => void }) {
  const n = uncategorized.ids.length;
  return (
    <div className="import-assist">
      <MessageSquareText size={16} aria-hidden />
      <p>
        {n === 1 ? "1 new transaction has no category." : `${n} new transactions have no category.`}
        <small>Opens the assistant with them attached. Nothing is sent until you press Send.</small>
      </p>
      <button type="button" className="secondary small" onClick={onCategorize}>
        Categorize with the assistant
      </button>
    </div>
  );
}
