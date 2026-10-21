import { useState, type FormEvent } from "react";
import { Modal } from "./forms";
import { FLAGS, FlagIcon } from "./TransactionRow";
import type { Budget } from "./types";

/** Keeps names for the flags in the budget, or none when every flag goes by its color. */
export function setFlagNames(b: Budget, names: Record<string, string>) {
  if (Object.keys(names).length) b.flagNames = names;
  else delete b.flagNames;
}

/** Names for the six flag colors, kept with the budget. A blank name goes back to the color. */
export function FlagNamesDialog({
  budget,
  close,
  save,
}: {
  budget: Pick<Budget, "flagNames">;
  close: () => void;
  save: (names: Record<string, string>) => void;
}) {
  const [names, setNames] = useState<Record<string, string>>(() => ({ ...budget.flagNames }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(
      Object.fromEntries(
        FLAGS.flatMap(([flag]) => {
          const name = names[flag]?.trim();
          return name ? [[flag, name]] : [];
        }),
      ),
    );
    close();
  };
  return (
    <Modal title="Flag names" close={close}>
      <form onSubmit={submit}>
        <p className="help">Name the flags the way you use them, like Reimburse or Tax. A flag without a name goes by its color.</p>
        <div className="flag-names">
          {FLAGS.map(([flag, color]) => (
            <label key={flag}>
              <FlagIcon flag={flag} size={12} />
              <input
                aria-label={`${color} flag's name`}
                placeholder={color}
                maxLength={40}
                value={names[flag] ?? ""}
                onChange={(e) => setNames((n) => ({ ...n, [flag]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary">Save names</button>
        </div>
      </form>
    </Modal>
  );
}
