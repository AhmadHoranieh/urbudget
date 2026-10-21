import { useEffect, useRef, useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import { Modal } from "./forms";
import { api, type BudgetListing } from "./bridge";
import { BudgetFormatFields, type FormatValue } from "./BudgetFormatFields";
import { newBudget, type BudgetStart } from "./newBudget";
import { errorText, numberFormatFor } from "./format";
import { useToast } from "./ui";
import type { Budget, Summary } from "./types";

/** Creates a budget file and opens it. */
export function NewBudgetDialog({
  current,
  close,
  open,
}: {
  current: { budget: Budget; summary: Summary; token: string };
  close: () => void;
  /** Switches to the new budget (saving the open one first). */
  open: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState<FormatValue>({
    currency: current.budget.currency,
    numberFormat: numberFormatFor(current.budget.currency, current.budget.numberFormat),
    dateFormat: current.budget.dateFormat ?? "iso",
  });
  const [start, setStart] = useState<BudgetStart>("starter");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [created, setCreated] = useState<string | null>(null);
  const options: [BudgetStart, string, string][] = [
    ["starter", "Starter categories", "Bills, needs, wants and savings groups to rename or delete."],
    ["blank", "Empty", "No accounts or categories."],
    [
      "copy",
      `Start over from “${current.budget.name}”`,
      "Keeps the same currency, balances, pending and future transactions, categories, targets, payees, rules and schedules. Settled history is removed; bank accounts need linking again.",
    ],
  ];
  return (
    <Modal title="New budget" close={() => { if (!pending.current) close(); }}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending.current) return;
          if (!name.trim()) return setError("Give the budget a name.");
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            const id = created ?? await api.createBudget(
              newBudget({ name, start, ...format }, current),
              start === "copy" ? { budget: current.budget, token: current.token } : undefined,
            );
            setCreated(id);
            await open(id);
            close();
          } catch (e) {
            setError(errorText(e));
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy || created !== null} style={{ border: 0, margin: 0, padding: 0, display: "contents" }}>
        <label>
          Budget name
          <input
            autoFocus
            required
            maxLength={200}
            placeholder="e.g. Household, Business, Travel 2027"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <BudgetFormatFields value={format} onChange={setFormat} />
        <fieldset className="choice-list">
          <legend>Start with</legend>
          {options.map(([value, title, help]) => (
            <label key={value} className={`choice${start === value ? " selected" : ""}`}>
              <input
                type="radio"
                name="start"
                value={value}
                checked={start === value}
                onChange={() => setStart(value)}
              />
              <span>
                <strong>{title}</strong>
                <small>{help}</small>
              </span>
            </label>
          ))}
        </fieldset>
        </fieldset>
        {created && <p className="muted">Your new budget was created. Retry opening it after resolving the error, or find it later in Budgets.</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? (created ? "Opening…" : "Creating…") : created ? "Open created budget" : "Create budget"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Lists budgets to open, show in the file manager, or move to the trash folder. */
export function ManageBudgetsDialog({
  close,
  open,
  onNew,
}: {
  close: () => void;
  open: (id: string) => Promise<void>;
  onNew?: () => void;
}) {
  const toast = useToast();
  const [budgets, setBudgets] = useState<BudgetListing[] | null>(null);
  const [confirm, setConfirm] = useState<BudgetListing | null>(null);
  useEffect(() => {
    void api
      .listBudgets()
      .then(setBudgets)
      .catch((e) => toast({ message: errorText(e), tone: "error" }));
  }, [toast]);
  return (
    <Modal title="Budgets" close={close}>
      {confirm ? (
        <>
          <p>
            Delete <strong>{confirm.name}</strong>? Its file moves to the <em>trash</em> folder
            next to your budgets, so it can still be recovered by hand.
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setConfirm(null)}>
              Keep it
            </button>
            <button
              className="danger"
              onClick={async () => {
                try {
                  setBudgets(await api.deleteBudget(confirm.id));
                  toast({ message: `Deleted ${confirm.name}.` });
                } catch (e) {
                  toast({ message: errorText(e), tone: "error" });
                }
                setConfirm(null);
              }}
            >
              Delete budget
            </button>
          </div>
        </>
      ) : (
        <>
          <ul className="budget-list">
            {(budgets ?? []).map((b) => (
              <li key={b.id} className={b.current ? "current" : ""}>
                <div>
                  <strong>{b.name}</strong>
                  <small>
                    {b.missing
                      ? "File not found"
                      : `${b.currency}${b.current ? " · Open now" : b.lastOpened ? ` · Opened ${new Date(b.lastOpened).toLocaleDateString()}` : ""}`}
                  </small>
                </div>
                <div className="row-actions">
                  {!b.current && !b.missing && (
                    <button
                      className="secondary"
                      onClick={async () => {
                        try {
                          await open(b.id);
                          close();
                        } catch (e) {
                          toast({ message: errorText(e), tone: "error" });
                        }
                      }}
                    >
                      Open
                    </button>
                  )}
                  <button
                    className="icon-button"
                    title="Show in folder"
                    aria-label={`Show ${b.name} in folder`}
                    disabled={b.missing}
                    onClick={() => void api.reveal(b.path).catch((e) => toast({ message: errorText(e), tone: "error" }))}
                  >
                    <FolderOpen size={15} />
                  </button>
                  <button
                    className="icon-button"
                    title={b.current ? "Open another budget to delete this one" : "Delete"}
                    aria-label={`Delete ${b.name}`}
                    disabled={b.current || (budgets?.length ?? 0) < 2}
                    onClick={() => setConfirm(b)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </li>
            ))}
            {!budgets && <li className="muted">Loading…</li>}
          </ul>
          <div className="modal-actions">
            <button className="secondary" onClick={close}>
              Close
            </button>
            {onNew && <button
              className="primary"
              onClick={() => {
                close();
                onNew();
              }}
            >
              New budget…
            </button>}
          </div>
        </>
      )}
    </Modal>
  );
}
