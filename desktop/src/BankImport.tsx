import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Download, FileText, FileUp, MessageSquareText, X } from "lucide-react";
import { api, type BankRow } from "./bridge";
import { placeholder } from "./bankNames";
import { errorText, formatDate, money } from "./format";
import { today, type Budget } from "./types";
import { useToast, useVirtualRows } from "./ui";
import { list, msg, t, tn } from "./i18n";
import "./import.css";

/** Each review row is this tall, so a long bank file only renders the rows in view. */
const REVIEW_ROW = 41;
const FORMATS: Record<string, string> = { csv: "CSV", ofx: "OFX", qfx: "QFX", qif: "QIF" };
const DATE_ORDERS: [string, string][] = [
  ["ymd", msg("Year-month-day (2026-10-31)")],
  ["dmy", msg("Day/month/year (31/10/2026)")],
  ["mdy", msg("Month/day/year (10/31/2026)")],
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
    t("Help me import this file into {account}.", { account }),
    problem && t("The import preview said: {problem}", { problem }),
    t("Find the transactions, ask me about anything unclear, and prepare them for the import review."),
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
  names.length < 2 ? names.join("") : t("{items} and {last}", { items: list(names.slice(0, -1)), last: names[names.length - 1] });
/** What the assistant is asked about them, ready to send with them attached; never sent by itself. */
export function categorizeText({ ids, accounts }: Uncategorized) {
  const where = join(accounts);
  if (ids.length > ATTACH_LIMIT)
    return tn(
      ids.length,
      "Categorize these {limit} of the {count} new transactions in {where}.",
      "Categorize these {limit} of the {count} new transactions in {where}.",
      { limit: ATTACH_LIMIT, where },
    );
  return ids.length === 1
    ? t("Categorize the new transaction in {where}.", { where })
    : tn(ids.length, "Categorize the {count} new transactions in {where}.", "Categorize the {count} new transactions in {where}.", {
        where,
      });
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
  onAskAssistant?: (file: File, problem: string) => void;
}) {
  const toast = useToast();
  const [account, setAccount] = useState(initialAccount ?? budget.accounts.find((a) => !a.archived)?.id ?? ""),
    [format, setFormat] = useState("csv"),
    [dateFormat, setDateFormat] = useState("ymd"),
    [flipSigns, setFlipSigns] = useState(false),
    [file, setFile] = useState<File | null>(initialFile ?? null),
    [dragging, setDragging] = useState(false),
    [rows, setRows] = useState<BankRow[]>([]),
    [base, setBase] = useState<Budget | null>(null),
    [message, setMessage] = useState(""),
    [left, setLeft] = useState<Uncategorized | null>(null),
    [busy, setBusy] = useState(false);
  // The last preview failed or found nothing, so the file needs another reading.
  const [failed, setFailed] = useState(false);
  const accountName = budget.accounts.find((a) => a.id === account)?.name ?? "";
  const reset = () => {
    setRows([]);
    setMessage("");
    setLeft(null);
    setFailed(false);
  };
  const choose = (next: File | null) => {
    setFile(next);
    const ext = next?.name.split(".").pop()?.toLowerCase();
    if (ext && ext in FORMATS) setFormat(ext);
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
      // The file's name and contents are a format other programs read: they stay in English.
      const path = await api.writeExport("bank-import-template.csv", bankTemplate(dateFormat));
      toast({
        message: t("Template saved."),
        action: { label: t("Show in folder"), onClick: () => void api.reveal(path).catch((e) => setMessage(errorText(e))) },
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
        await file.text(),
        format,
        dateFormat,
        format === "csv" && flipSigns,
      );
      setRows(r);
      setBase(budget);
      if (!r.length) setMessage(t("The file has no transactions to import."));
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
        if (b !== base) throw Error(t("Your budget changed. Preview the file again before importing."));
        const after = await api.importBank(b, account, choices);
        uncategorized = uncategorizedImports(b, after);
        return after;
      });
      setRows([]);
      setFile(null);
      if (onImported) onImported(importing, uncategorized);
      else {
        setMessage(
          tn(
            importing,
            "Imported {count} transaction. They're waiting for your approval.",
            "Imported {count} transactions. They're waiting for your approval.",
          ),
        );
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
  const problem = failed ? message : allIn ? t("Every row came out as money in.") : "";
  return (
    <Wrapper className={`bank-import${embedded ? "" : " panel"}`}>
      {!embedded && <h2>{t("Import a bank file")}</h2>}
      {!rows.length ? (
        <>
          <p className="import-lead">
            {t("Bring in the transactions your bank exported. You check every row, and how it matches what you already entered, before anything is saved.")}
          </p>
          {!initialAccount && (
            <label className="import-account">
              {t("Into account")}
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
              <strong>{file ? file.name : t("Choose a file")}</strong>
              <small>
                {file
                  ? t("{format} · {size} KB · click to choose another", {
                      format: FORMATS[format] ?? format.toUpperCase(),
                      size: Math.max(1, Math.round(file.size / 1024)),
                    })
                  : t("or drop it here · CSV, OFX, QFX or QIF")}
              </small>
            </span>
            {file && (
              <button
                type="button"
                className="icon-button"
                aria-label={t("Remove the file")}
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
              aria-label={t("Bank file")}
              accept=".csv,.ofx,.qfx,.qif,.txt"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                choose(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </label>
          {file && (
            <div className="import-options">
              <label>
                {t("Read as")}
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
                  {t("Dates in the file")}
                  <select
                    value={dateFormat}
                    onChange={(e) => {
                      setDateFormat(e.target.value);
                      reset();
                    }}
                  >
                    {DATE_ORDERS.map(([id, name]) => (
                      <option key={id} value={id}>
                        {t(name)}
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
                      setFlipSigns(e.target.checked);
                      reset();
                    }}
                  />
                  {t("Purchases are positive")}
                </label>
              )}
            </div>
          )}
          <div className="import-help">
            <p>
              {/* Column names are what the file must contain, so they stay in English. */}
              {t(
                "{csv} need a header row with {date}, {payee} (or Description), and either {amount} (negative for money out) or {outflow} and {inflow}. {memo} is optional. If a card lists purchases as positive amounts, tick {option}.",
                {
                  csv: <strong>{t("CSV files")}</strong>,
                  date: <b>Date</b>,
                  payee: <b>Payee</b>,
                  amount: <b>Amount</b>,
                  outflow: <b>Outflow</b>,
                  inflow: <b>Inflow</b>,
                  memo: <b>Memo</b>,
                  option: <b>{t("Purchases are positive")}</b>,
                },
              )}
            </p>
            <button type="button" className="secondary small" onClick={() => void template()}>
              <Download size={14} /> {t("Download a template")}
            </button>
          </div>
          <div className="form-actions">
            <button className="primary" disabled={!file || busy || !account} onClick={() => void preview()}>
              {busy ? t("Reading the file…") : t("Preview transactions")}
            </button>
          </div>
        </>
      ) : (
        <ImportReview
          budget={budget}
          rows={rows}
          busy={busy}
          icon={<FileText size={18} aria-hidden />}
          title={t("{source} into {account}", { source: <strong>{file?.name}</strong>, account: accountName })}
          action={
            <button className="link-button" onClick={reset}>
              {t("Change file")}
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
            {failed
              ? t("The assistant can read this file, find the transactions and ask you about anything unclear.")
              : allIn
                ? t("Every row came out as money in. If these are purchases, the signs are probably reversed, and the assistant can check the file with you.")
                : rows.length
                  ? t("If something here doesn't look right, the assistant can go through the file with you.")
                  : t("Not sure how this file will import? The assistant can read it and prepare it for you.")}
            <small>{t("Opens the assistant with this file attached. Nothing is sent until you press Send.")}</small>
          </p>
          <button
            type="button"
            className={problem ? "primary small" : "secondary small"}
            onClick={() => onAskAssistant(file, problem)}
          >
            {t("Help with this import")}
          </button>
        </div>
      )}
    </Wrapper>
  );
}

export type ImportChoice = { row: BankRow; action: string; matchId: string | null };

/** Skip known bank IDs and take a single match only when that account side has not been imported. */
const defaultChoice = (r: BankRow) => {
  if (r.duplicate) return "skip";
  if (r.possibleDuplicate) return "review";
  if (!r.candidates.length) return "new";
  return r.candidates.length === 1 && !r.previouslyMatchedCandidates?.includes(r.candidates[0])
    ? `match:${r.candidates[0]}` : "review";
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
  cancelLabel = t("Cancel"),
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
  const importing = rows.filter((r) => choice(r) !== "skip").length;
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
          {title} · {tn(rows.length, "{count} row", "{count} rows")}
          {duplicates > 0 && ` · ${tn(duplicates, "{count} already imported", "{count} already imported")}`}
          {renamed > 0 && ` · ${tn(renamed, "{count} renamed by your payee rules", "{count} renamed by your payee rules")}`}
        </span>
        {action}
      </div>
      <p className="help import-note">
        {t("Matching keeps your category and memo and marks the transaction cleared. Imported transactions wait for your approval.")}
      </p>
      {rows.some((r) => r.possibleDuplicate || (r.idless && r.duplicate)) && <p className="help import-note">
        {t("This file has no bank transaction IDs. A row may already be imported; compare its memo and amount. Skip it if it is the same payment, or add it separately if it is a different payment.")}
      </p>}
      <div className="table-scroll import-review" ref={review}>
        <table>
          <thead>
            <tr>
              <th>{t("Date")}</th>
              <th>{t("Payee")}</th>
              <th className="num">{t("Amount")}</th>
              <th>{t("What to do")}</th>
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
                  <td title={r.rename ? t("{name}, from the bank's “{payee}”", { name: r.rename, payee: r.payee }) : undefined}>
                    {r.rename ?? r.payee}
                    {r.rename && <small className="bank-text">{r.payee}</small>}
                    {r.memo && <small className="bank-text" title={r.memo}>{r.memo}</small>}
                  </td>
                  <td className="num">{money(r.amount)}</td>
                  <td>
                    {r.duplicate && !r.idless ? (
                      t("Already imported · skipped")
                    ) : (
                      <select
                        aria-label={t("Import action {number}", { number: index + 1 })}
                        disabled={busy}
                        value={choice(r)}
                        onChange={(e) => setChoices({ ...choices, [r.id]: e.target.value })}
                      >
                        {!r.duplicate && (
                          <option value="review">
                            {r.possibleDuplicate ? t("May already be imported — choose") : t("Choose a match or add it")}
                          </option>
                        )}
                        {r.duplicate
                          ? <option value="separate">{t("Add as a separate transaction")}</option>
                          : <option value="new">{t("Add as a new transaction")}</option>}
                        <option value="skip">{r.duplicate ? t("Already imported — skip") : t("Skip")}</option>
                        {(r.duplicate ? [] : r.candidates).map((id) => {
                          const detail = r.candidateDetails?.find((c) => c.id === id);
                          const tx = byId.get(detail?.transactionId ?? id);
                          const part = detail && tx?.splits[detail.splitIndex];
                          const memo = part?.memo || tx?.memo;
                          return (
                            <option key={id} value={`match:${id}`}>
                              {t("Match: {date} · {payee}", { date: tx ? formatDate(tx.date) : "", payee: tx?.payee || t("Transfer") })}
                              {detail ? ` · ${t("Split {number}", { number: detail.splitIndex + 1 })}` : ""}
                              {memo ? ` · ${memo}` : ""}
                              {r.previouslyMatchedCandidates?.includes(id) ? ` · ${t("Previously imported")}` : ""}
                            </option>
                          );
                        })}
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
          <span className="help">{tn(undecided, "{count} row needs a choice", "{count} rows need a choice")}</span>
        )}
        <button className="secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button className="primary" disabled={busy || undecided > 0 || !importing} onClick={() => onImport(chosen(), importing)}>
          {busy ? t("Importing…") : tn(importing, "Import {count} transaction", "Import {count} transactions")}
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
        {n === 1
          ? t("1 new transaction has no category.")
          : tn(n, "{count} new transactions have no category.", "{count} new transactions have no category.")}
        <small>{t("Opens the assistant with them attached. Nothing is sent until you press Send.")}</small>
      </p>
      <button type="button" className="secondary small" onClick={onCategorize}>
        {t("Categorize with the assistant")}
      </button>
    </div>
  );
}
