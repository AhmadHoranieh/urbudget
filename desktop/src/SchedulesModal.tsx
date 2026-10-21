import { CornerDownLeft, Pause, Play, Plus, SkipForward, Trash2 } from "lucide-react";
import { Modal } from "./forms";
import { formatDate, money } from "./format";
import { frequencies } from "./Planning";
import type { Schedule } from "./types";
import type { Upcoming } from "./Register";

/**
 * A register's scheduled transactions in one list (its Scheduled button): what's due in the next
 * 30 days, every schedule soonest first with paused ones after, and a way to add one. Each opens
 * in the schedule editor; the buttons on it enter, skip, pause or delete it.
 */
export function SchedulesModal({
  title,
  items,
  showAccount,
  close,
  onEdit,
  onEnter,
  onSkip,
  onPause,
  onDelete,
}: {
  title: string;
  items: Upcoming[];
  /** All transactions lists every account's, so each says whose it is. */
  showAccount: boolean;
  close: () => void;
  /** Opens a schedule in the editor, or a new one. */
  onEdit: (s?: Schedule) => void;
  onEnter: (u: Upcoming) => void;
  onSkip: (u: Upcoming) => void;
  onPause: (s: Schedule, paused: boolean) => void;
  onDelete: (u: Upcoming) => void;
}) {
  const list = [...items].sort(
    (a, b) => Number(a.s.paused) - Number(b.s.paused) || a.date.localeCompare(b.date),
  );
  const limit = new Date();
  limit.setDate(limit.getDate() + 30);
  const end = limit.toLocaleDateString("en-CA");
  const due = list.filter((u) => !u.s.paused && u.date <= end);
  const paused = list.filter((u) => u.s.paused).length;
  const out = due.reduce((n, u) => n + Math.max(0, -u.amount), 0);
  const into = due.reduce((n, u) => n + Math.max(0, u.amount), 0);
  return (
    <Modal title={title} close={close} wide className="schedules-modal">
      <div className="schedules-intro">
        <div className="figures" role="group" aria-label="Scheduled and the next 30 days">
          <div className="stat">
            <span>Scheduled</span>
            <strong>
              {list.length - paused}
              {paused > 0 && <small> · {paused} paused</small>}
            </strong>
          </div>
          <div className="stat">
            <span>Due in 30 days</span>
            <strong>{due.length}</strong>
          </div>
          <div className="stat">
            <span>Going out</span>
            <strong>{money(out)}</strong>
          </div>
          <div className="stat">
            <span>Coming in</span>
            <strong className={into ? "positive" : ""}>{money(into)}</strong>
          </div>
        </div>
        <button className="primary" onClick={() => onEdit()}>
          <Plus size={15} /> New scheduled transaction
        </button>
      </div>
      <p className="help">
        A transaction dated ahead waits here and is entered on its date, uncleared and waiting for
        approval; a repeating one carries on from there.
      </p>
      {!list.length ? (
        <div className="schedules-empty">
          <h3>Nothing scheduled</h3>
          <p>Add a transaction with a later date, or choose how often it repeats, and it waits here.</p>
        </div>
      ) : (
        <ul className="schedule-list" aria-label="Scheduled transactions">
          {list.map((u) => {
            const often = frequencies[u.s.frequency] ?? u.s.frequency;
            return (
              <li key={u.s.id} className={u.s.paused ? "paused" : undefined}>
                <button className="schedule-main" onClick={() => onEdit(u.s)} title="Edit">
                  <span className="schedule-date">{formatDate(u.date)}</span>
                  <span className="schedule-name">{u.transfer?.label ?? u.payee}</span>
                  <span className="schedule-meta">
                    {u.s.paused && <span className="repeat-label paused-label">Paused</span>}
                    <span className="repeat-label">{often}</span>
                    {[showAccount && u.account, u.category].filter(Boolean).join(" · ")}
                  </span>
                </button>
                <span className={`schedule-amount${u.amount > 0 ? " positive" : ""}`}>{money(u.amount)}</span>
                <span className="schedule-actions-row">
                  <button
                    className="icon-button"
                    aria-label={`Enter ${u.payee} now`}
                    title="Enter now: adds it to the register dated today"
                    onClick={() => onEnter(u)}
                  >
                    <CornerDownLeft size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Skip ${u.payee} on ${formatDate(u.date)}`}
                    title={u.s.frequency === "never" ? "Skip it: it won't be entered" : `Skip ${formatDate(u.date)}`}
                    onClick={() => onSkip(u)}
                  >
                    <SkipForward size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`${u.s.paused ? "Resume" : "Pause"} ${u.payee}`}
                    title={u.s.paused ? "Resume" : "Pause"}
                    onClick={() => onPause(u.s, !u.s.paused)}
                  >
                    {u.s.paused ? <Play size={15} /> : <Pause size={15} />}
                  </button>
                  <button
                    className="icon-button danger-hover"
                    aria-label={`Delete ${u.payee}`}
                    title="Delete"
                    onClick={() => onDelete(u)}
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
