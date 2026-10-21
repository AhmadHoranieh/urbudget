import { useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { Modal } from "../forms";
import { errorText } from "../format";
import { assistant } from "./api";

/** Reporting is an explicit, editable submission; never send the rest of a conversation. */
export function ReplyReport({ text, close }: { text: string; close: () => void }) {
  // Do not split an emoji's surrogate pair at the native JSON boundary.
  const [excerpt, setExcerpt] = useState(() => text.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, ""));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");
  return createPortal(
    <Modal title="Report this reply" close={() => { if (!busy) close(); }}>
      {reference ? (
        <div className="reply-report">
          <p role="status">Report sent. Thank you for helping us review the assistant's replies.</p>
          <p className="help">Keep this reference if you want to ask us to delete the report: <code>{reference}</code></p>
          <div className="form-actions"><button className="primary" onClick={close}>Done</button></div>
        </div>
      ) : (
        <form className="reply-report" onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !excerpt.trim()) return;
          setBusy(true);
          setError("");
          try {
            setReference(await assistant.reportReply(excerpt.trim(), reason.trim()));
          } catch (failure) {
            setError(errorText(failure));
          } finally {
            setBusy(false);
          }
        }}>
          <p className="help">
            Send the text below to UrBudget for review. Remove names, balances or anything private first.
            Reports are deleted after 90 days. No other conversation text, attachments or account details are added.
          </p>
          <label className="field-wide">
            Reply to include
            <textarea data-autofocus rows={7} maxLength={4000} value={excerpt} disabled={busy}
              onChange={(event) => setExcerpt(event.target.value)} />
          </label>
          {text.length > 4000 && <p className="help">The first 4,000 characters are included. You can replace them with the part you want to report.</p>}
          <label className="field-wide">
            What's wrong? (optional)
            <textarea rows={3} maxLength={1000} value={reason} disabled={busy}
              onChange={(event) => setReason(event.target.value)} />
          </label>
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
            <button className="primary" disabled={busy || !excerpt.trim() || excerpt.trim().length > 4000 || reason.trim().length > 1000}>
              {busy && <LoaderCircle size={14} className="spin" />} {busy ? "Sending…" : "Send report"}
            </button>
          </div>
        </form>
      )}
    </Modal>,
    document.body,
  );
}
