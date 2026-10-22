import { useState } from "react";
import { Check, Eye, FileDown, FileSpreadsheet, LoaderCircle, RefreshCw, TriangleAlert, Undo2 } from "lucide-react";
import { money } from "../format";
import type { CardRow, Proposal } from "./api";
import { ltr, t, tn } from "../i18n";

// The sign stays with the amount in Arabic too.
const signed = (n: number) => (n > 0 ? ltr(`+${money(n)}`) : money(n));

function Row({ row, budget }: { row: CardRow; budget: boolean }) {
  return (
    <div className={`proposal-row${row.tone === "warn" ? " warn" : ""}`}>
      <span className="proposal-label">
        <span title={row.label}>{row.label}</span>
        {row.detail && <small title={row.detail}>{row.detail}</small>}
      </span>
      {row.badge && <span className={`proposal-badge${row.tone === "warn" ? " warn" : ""}`}>{row.badge}</span>}
      {budget && row.amount !== undefined ? (
        <span className={`num${row.amount > 0 ? " positive" : ""}`}>{signed(row.amount)}</span>
      ) : (
        row.amount !== undefined && <span className="num">{money(row.amount)}</span>
      )}
      {row.before !== undefined && row.after !== undefined && (
        <span className="num muted proposal-change">
          {ltr(`${money(row.before)} → ${money(row.after)}`)}
        </span>
      )}
    </div>
  );
}

/**
 * A change the assistant prepared. Nothing happens until Apply; an applied card shrinks to one
 * line with Undo while the change is still the latest one.
 */
export function ProposalCard({
  proposal: p,
  canUndo,
  onApply,
  onDiscard,
  onUndo,
  onReview,
  onSave,
  onPreview,
  onPrint,
  onSheet,
}: {
  /** Reports: open the preview, or go straight to the print dialog. */
  onPreview?: () => void;
  onPrint?: () => Promise<void>;
  /** Spreadsheets, and reports with tables: save the .xlsx file, or open it. */
  onSheet?: (open: boolean) => Promise<void>;
  proposal: Proposal;
  canUndo: boolean;
  onApply: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onUndo: () => Promise<void>;
  onReview: () => void;
  onSave: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  const c = p.card;
  if (p.status === "applied" || p.status === "discarded" || p.status === "undone") {
    const label =
      p.status === "applied"
        ? t("Applied: {title}", { title: p.title })
        : p.status === "undone"
          ? t("Undone: {title}", { title: p.title })
          : t("Discarded: {title}", { title: p.title });
    return (
      <div className={`proposal done ${p.status}`}>
        {p.status === "applied" ? <Check size={14} aria-hidden /> : <Undo2 size={14} aria-hidden />}
        <span>{label}</span>
        {p.status === "applied" && canUndo && (
          <button className="secondary small" disabled={busy} onClick={run(onUndo)}>
            {t("Undo")}
          </button>
        )}
        {p.status === "undone" && (
          <button className="secondary small" disabled={busy} onClick={run(onApply)}>
            {t("Apply again")}
          </button>
        )}
      </div>
    );
  }
  const isImport = p.kind === "import";
  const isBudget = p.kind === "budget";
  return (
    <div className={`proposal${p.status === "failed" ? " failed" : ""}`} aria-label={t("Proposal: {title}", { title: p.title })}>
      <div className="proposal-head">
        <span className="proposal-kicker">{c.kicker}</span>
        <strong>{p.title}</strong>
      </div>
      {c.stats.length > 0 && (
        <div className="proposal-stats">
          {c.stats.map((s) => (
            <div key={s.label}>
              <small>{s.label}</small>
              <b className="num">{s.text ?? (s.amount !== undefined ? money(s.amount) : "")}</b>
            </div>
          ))}
        </div>
      )}
      {c.rows.map((row, i) => (
        <Row key={i} row={row} budget={isBudget} />
      ))}
      {c.more > 0 && <div className="proposal-more">{tn(c.more, "and {count} more", "and {count} more")}</div>}
      {c.total && (
        <div className="proposal-total">
          <Row row={c.total} budget={isBudget} />
        </div>
      )}
      {c.check && (
        <div className={`proposal-check${c.check[0] ? " ok" : " bad"}`}>
          {c.check[0] ? <Check size={13} aria-hidden /> : <TriangleAlert size={13} aria-hidden />}
          {c.check[1]}
        </div>
      )}
      {(c.warning || p.problem) && (
        <div className="proposal-warning">
          <TriangleAlert size={13} aria-hidden />
          {p.problem ?? c.warning}
        </div>
      )}
      {c.note && <div className="proposal-note">{c.note}</div>}
      <div className="proposal-actions">
        {p.status === "failed" ? (
          <button className="secondary small" disabled={busy} onClick={run(onDiscard)}>
            {t("Dismiss")}
          </button>
        ) : p.kind === "report" ? (
          <>
            <button className="primary small" disabled={busy} onClick={onPreview}>
              <Eye size={13} aria-hidden /> {t("Preview")}
            </button>
            <button className="secondary small" disabled={busy} onClick={onPrint && run(onPrint)}>
              <FileDown size={13} aria-hidden /> {t("Save as PDF")}
            </button>
            {p.sheets > 0 && onSheet && (
              <button
                className="secondary small"
                disabled={busy}
                title={t("Each table on its own sheet ({count})", { count: p.sheets })}
                onClick={run(() => onSheet(false))}
              >
                <FileSpreadsheet size={13} aria-hidden /> Excel
              </button>
            )}
            <button className="link-button" disabled={busy} onClick={run(onDiscard)}>
              {t("Discard")}
            </button>
          </>
        ) : p.kind === "spreadsheet" ? (
          <>
            <button className="primary small" disabled={busy || !onSheet} onClick={onSheet && run(() => onSheet(true))}>
              {busy ? <LoaderCircle size={13} className="spin" aria-hidden /> : <FileSpreadsheet size={13} aria-hidden />} {t("Open")}
            </button>
            <button className="secondary small" disabled={busy || !onSheet} onClick={onSheet && run(() => onSheet(false))}>
              <FileDown size={13} aria-hidden /> {t("Save")}
            </button>
            <button className="link-button" disabled={busy} onClick={run(onDiscard)}>
              {t("Discard")}
            </button>
          </>
        ) : isImport ? (
          <>
            <button className="primary small" disabled={busy} onClick={onReview}>
              {t("Review import")}
            </button>
            <button className="secondary small" disabled={busy} onClick={run(onSave)}>
              <FileDown size={13} aria-hidden /> {t("Save as CSV")}
            </button>
            <button className="link-button" disabled={busy} onClick={run(onDiscard)}>
              {t("Discard")}
            </button>
          </>
        ) : (
          <>
            <button className="primary small" disabled={busy} onClick={run(onApply)}>
              {busy ? <LoaderCircle size={13} className="spin" aria-hidden /> : p.problem ? <RefreshCw size={13} aria-hidden /> : null}
              {t("Apply")}
            </button>
            <button className="secondary small" disabled={busy} onClick={run(onDiscard)}>
              {t("Discard")}
            </button>
            <span className="proposal-hint">{t("One undo step")}</span>
          </>
        )}
      </div>
    </div>
  );
}
