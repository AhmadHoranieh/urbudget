import { useEffect, useRef, useState } from "react";
import { Landmark, LoaderCircle, MessageSquareText, RefreshCw } from "lucide-react";
import { CategorizeOffer, ImportReview, uncategorizedImports, type ImportChoice, type Uncategorized } from "./BankImport";
import { simplefin, type AccountReview, type SimpleFinAccount, type SimpleFinStatus, type Synced } from "./simplefin";
import { errorText, formatDate, money } from "./format";
import { today, type Account, type Budget, type Summary } from "./types";
import { DateInput, useToast } from "./ui";
import "./import.css";

/** A first sync brings in this many days unless the user picks another start. */
const FIRST_DAYS = 30;
export const daysAgo = (n: number, from = today()) => {
  const [y, m, d] = from.split("-").map(Number);
  const day = new Date(y, m - 1, d - n);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

/** Links `sf` to the account `target` (or to none), in an edit draft. One budget account per SimpleFIN account. */
export function linkAccount(d: Budget, sf: SimpleFinAccount, target: string | null, from = daysAgo(FIRST_DAYS)) {
  for (const a of d.accounts) if (a.simplefin?.id === sf.id) delete a.simplefin;
  const account = d.accounts.find((a) => a.id === target);
  if (account) account.simplefin = { id: sf.id, name: sf.name, org: sf.org, from };
}

/** Every SimpleFIN account to show: the ones SimpleFIN listed, then any linked ones it hasn't listed yet. */
export function listedAccounts(budget: Budget, listed: SimpleFinAccount[]): SimpleFinAccount[] {
  const extra = budget.accounts
    .filter((a) => a.simplefin && !listed.some((s) => s.id === a.simplefin!.id))
    .map((a) => ({
      id: a.simplefin!.id,
      name: a.simplefin!.name ?? a.name,
      org: a.simplefin!.org ?? "",
      currency: budget.currency,
      balance: null,
      balanceDate: null,
    }));
  return [...listed, ...extra];
}

/** What the assistant is asked about an account's bank sync: ready to send, not sent. */
export function syncHelpText(account: string, problem = "") {
  return [
    `Help me with bank sync for ${account}.`,
    problem && `The sync said: ${problem}`,
    "Check how it's linked, when it last synced, and whether its balance and signs look right.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A synced account whose last sync is over a week old, or that hasn't synced yet. */
export const staleSync = (a: Account, now = today()) => !a.simplefin?.lastSync || a.simplefin.lastSync < daysAgo(7, now);

/** Settings › Import: connect SimpleFIN Bridge and choose which accounts it fills. */
export function BankSyncSettings({
  budget,
  edit,
  onSync,
}: {
  budget: Budget;
  edit: (update: (draft: Budget) => void) => void;
  onSync: () => void;
}) {
  const [status, setStatus] = useState<SimpleFinStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    simplefin.status().then(setStatus, () => setStatus(null));
  }, []);
  const run = async (what: string, work: () => Promise<SimpleFinStatus>) => {
    setBusy(what);
    setMessage("");
    try {
      setStatus(await work());
      return true;
    } catch (e) {
      setMessage(errorText(e));
      return false;
    } finally {
      setBusy("");
    }
  };
  if (!status) return null;
  const linked = budget.accounts.filter((a) => a.simplefin && !a.archived);
  const open = budget.accounts.filter((a) => !a.archived);
  const accounts = listedAccounts(budget, status.accounts);
  return (
    <section className="panel bank-sync">
      <h2>Bank sync</h2>
      {!status.store ? (
        <p className="import-lead">
          Bank sync keeps its connection in the system&apos;s credential store, which this computer doesn&apos;t have.
        </p>
      ) : !status.connected ? (
        <>
          <p className="import-lead">
            Bring in transactions from US and Canadian banks through SimpleFIN Bridge, a subscription you pay SimpleFIN
            for. Your bank login stays with SimpleFIN, and the transactions come straight to this computer. You review
            every one before it&apos;s added.
          </p>
          <ol className="bank-sync-steps">
            <li>
              At SimpleFIN Bridge, add your bank and make a setup token for UrBudget.{" "}
              <button type="button" className="link-button" onClick={() => void simplefin.openBridge().catch((e) => setMessage(errorText(e)))}>
                Open SimpleFIN Bridge
              </button>
            </li>
            <li>Paste the setup token here. It works once.</li>
          </ol>
          <label className="bank-sync-token">
            Setup token
            <textarea
              rows={3}
              value={token}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <span className="help">UrBudget keeps the connection in {status.store}, never in the budget file.</span>
            <button
              className="primary"
              disabled={!token.trim() || !!busy}
              onClick={async () => {
                if (await run("connect", () => simplefin.connect(token))) setToken("");
              }}
            >
              {busy === "connect" ? "Connecting…" : "Connect"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="import-lead">
            Connected to SimpleFIN Bridge. Choose the account each bank account syncs into, then press Sync on the
            account or here. You review every transaction before it&apos;s added.
          </p>
          {status.messages.map((m) => (
            <p key={m} className="notice">
              {m}
            </p>
          ))}
          {accounts.length ? (
            <div className="table-scroll">
              <table className="bank-sync-accounts">
                <thead>
                  <tr>
                    <th>At the bank</th>
                    <th className="num">Balance</th>
                    <th>Syncs into</th>
                    <th>Since</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((sf) => {
                    const into = budget.accounts.find((a) => !a.archived && a.simplefin?.id === sf.id);
                    const foreign = sf.currency !== budget.currency;
                    return (
                      <tr key={sf.id}>
                        <td>
                          {sf.name}
                          {sf.org && <small className="bank-text">{sf.org}</small>}
                        </td>
                        <td className="num">{sf.balance === null ? "" : money(sf.balance, { currency: sf.currency })}</td>
                        <td>
                          {foreign && !into ? (
                            <span className="help">
                              In {sf.currency ?? "a currency of its own"}; this budget uses {budget.currency}
                            </span>
                          ) : (
                            <select
                              aria-label={`Account for ${sf.name}`}
                              value={into?.id ?? ""}
                              onChange={(e) => edit((d) => linkAccount(d, sf, e.target.value || null))}
                            >
                              <option value="">Don&apos;t sync</option>
                              {open.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                  {a.simplefin && a.simplefin.id !== sf.id ? " (linked to another)" : ""}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td>
                          {into?.simplefin && (
                            <div className="bank-sync-since">
                              {into.simplefin.lastSync ? (
                                <span>Synced {formatDate(into.simplefin.lastSync)}</span>
                              ) : (
                                <DateInput
                                  label={`First day to bring in for ${sf.name}`}
                                  value={into.simplefin.from}
                                  onChange={(from) =>
                                    edit((d) => {
                                      const link = d.accounts.find((a) => a.id === into.id)!.simplefin!;
                                      link.from = from > today() ? today() : from < daysAgo(365) ? daysAgo(365) : from;
                                    })
                                  }
                                />
                              )}
                              {into.kind === "credit" && (
                                <label className="checkbox-label">
                                  <input
                                    type="checkbox"
                                    checked={!!into.simplefin.flipSigns}
                                    onChange={(e) =>
                                      edit((d) => {
                                        d.accounts.find((a) => a.id === into.id)!.simplefin!.flipSigns = e.target.checked;
                                      })
                                    }
                                  />
                                  Purchases arrive as money in
                                </label>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="help">SimpleFIN hasn&apos;t listed your accounts yet.</p>
          )}
          <p className="help">
            SimpleFIN allows about 24 requests a day. A sync is one request for every account; a first sync that reaches
            further back takes one per 45 days. Used today: {status.requestsToday} of {status.dailyLimit}.
          </p>
          {removing ? (
            <div className="notice bank-sync-remove">
              <span>
                Remove the connection? UrBudget forgets the SimpleFIN access and unlinks this budget&apos;s accounts.
                Transactions already imported stay. To stop SimpleFIN reading your bank, remove the bank at SimpleFIN
                Bridge too.
              </span>
              <button className="secondary small" onClick={() => setRemoving(false)}>
                Keep it
              </button>
              <button
                className="primary small"
                disabled={!!busy}
                onClick={async () => {
                  if (await run("remove", simplefin.disconnect)) {
                    setRemoving(false);
                    if (linked.length)
                      edit((d) => {
                        for (const a of d.accounts) delete a.simplefin;
                      });
                  }
                }}
              >
                Remove connection
              </button>
            </div>
          ) : (
            <div className="form-actions">
              <button className="text-button" onClick={() => setRemoving(true)}>
                Remove connection
              </button>
              <button className="secondary" disabled={!!busy} onClick={() => void run("refresh", simplefin.refresh)}>
                <RefreshCw size={14} className={busy === "refresh" ? "spin" : undefined} />{" "}
                {accounts.length ? "Refresh the list" : "List my accounts"}
              </button>
              <button className="primary" disabled={!linked.length || !!busy} onClick={onSync}>
                Sync now
              </button>
            </div>
          )}
        </>
      )}
      {message && (
        <p role="status" className="import-result">
          {message}
        </p>
      )}
    </section>
  );
}

/**
 * A sync: one download for every linked account, then each account's review in turn, starting
 * with `first`. Accounts with nothing new are marked synced; nothing else changes until the user
 * imports an account's rows.
 */
export function BankSync({
  budget,
  balances,
  first,
  transform,
  close,
  onAsk,
  onCategorize,
}: {
  budget: Budget;
  balances: Map<string, Summary["accounts"][number]>;
  /** The account whose Sync was pressed, reviewed first. */
  first?: string;
  transform: (work: (b: Budget) => Promise<Budget>) => Promise<void>;
  close: () => void;
  /** Opens the assistant about an account's sync, with what went wrong. */
  onAsk?: (account: Account, problem: string) => void;
  /** Offers the assistant the new transactions that came in without a category. */
  onCategorize?: (uncategorized: Uncategorized) => void;
}) {
  const toast = useToast();
  const [synced, setSynced] = useState<Synced | null>(null);
  // The budget the rows were checked against.
  const [base, setBase] = useState<Budget | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [imported, setImported] = useState(0);
  const [left, setLeft] = useState<Uncategorized>({ ids: [], accounts: [] });
  const latest = useRef(budget);
  latest.current = budget;
  const nothingNew = (r: AccountReview) => !r.error && r.rows.every((row) => row.duplicate);
  // Imports into the budget, then checks the remaining rows against the budget they'll go into.
  const commit = (work: (b: Budget) => Promise<Budget>, count = 0) =>
    transform(async (b) => {
      const next = await work(b);
      const again = await simplefin.sync(next, false);
      const fresh = uncategorizedImports(b, next);
      setSynced(again);
      setBase(next);
      setImported((n) => n + count);
      setLeft((l) => ({ ids: [...l.ids, ...fresh.ids], accounts: [...new Set([...l.accounts, ...fresh.accounts])] }));
      return next;
    });
  // One download per dialog, even when React runs the effect twice: each one counts against
  // SimpleFIN's daily requests.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const s = await simplefin.sync(budget, true);
        // Accounts with nothing new are synced through today; ones already marked are left alone,
        // so a quiet sync adds no empty undo step.
        const quiet = s.reviews.filter(
          (r) => nothingNew(r) && budget.accounts.find((a) => a.id === r.accountId)?.simplefin?.lastSync !== s.through,
        );
        if (quiet.length)
          await commit(async (b) => {
            let next = b;
            for (const r of quiet) next = await simplefin.import(next, r.accountId, [], s.through);
            return next;
          });
        else {
          setSynced(s);
          setBase(budget);
        }
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    })();
  }, []);
  const name = (id: string) => budget.accounts.find((a) => a.id === id)?.name ?? "";
  const reviews = synced ? [...synced.reviews].sort((a, b) => +(b.accountId === first) - +(a.accountId === first)) : [];
  const pending = reviews.filter((r) => !nothingNew(r) && !r.error && !skipped.includes(r.accountId));
  const current = pending[0];
  const save = async (r: AccountReview, choices: ImportChoice[], count: number) => {
    setBusy(true);
    setMessage("");
    try {
      if (latest.current !== base) {
        // Something else changed the budget (a schedule posting): check the rows again first.
        setSynced(await simplefin.sync(latest.current, false));
        setBase(latest.current);
        setMessage("Your budget changed, so these rows were checked again. Look them over, then import.");
        return;
      }
      await commit(async (b) => {
        if (b !== base) throw Error("Your budget changed. Sync again before importing.");
        return simplefin.import(b, r.accountId, choices, synced!.through);
      }, count);
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const done = synced && !current;
  const quietOnly = done && !busy && !synced.messages.length && reviews.every((r) => !r.error) && !skipped.length;
  useEffect(() => {
    if (quietOnly && imported) {
      close();
      toast({
        message: `Imported ${imported} ${imported === 1 ? "transaction" : "transactions"} from your bank for review.`,
        offer:
          onCategorize && left.ids.length
            ? { label: "Categorize with the assistant", onClick: () => onCategorize(left) }
            : undefined,
      });
    }
  }, [quietOnly]);
  const account = current && budget.accounts.find((a) => a.id === current.accountId);
  // A card whose every new row is money in: its bank probably sends purchases as deposits.
  const fresh = current?.rows.filter((r) => !r.duplicate) ?? [];
  const allIn = account?.kind === "credit" && fresh.length >= 3 && fresh.every((r) => r.amount > 0);
  const failed = done ? reviews.find((r) => r.error) : undefined;
  const about = account ?? budget.accounts.find((a) => a.id === (failed ?? reviews[0])?.accountId);
  const problem = allIn
    ? "Every new row from the card came in as money in."
    : (failed?.error ?? (done || account ? synced?.messages[0] : undefined));
  return (
    <div className="bank-import bank-sync-review">
      {synced?.messages.map((m) => (
        <p key={m} className="notice">
          {m}
        </p>
      ))}
      {error ? (
        <>
          <p className="notice error">{error}</p>
          <div className="form-actions">
            <button className="primary" onClick={close}>
              Close
            </button>
          </div>
        </>
      ) : !synced ? (
        <p className="bank-sync-wait">
          <LoaderCircle size={16} className="spin" aria-hidden /> Getting your transactions from SimpleFIN…
        </p>
      ) : current && account ? (
        <>
          <ImportReview
            key={current.accountId}
            budget={budget}
            rows={current.rows}
            busy={busy}
            icon={<Landmark size={18} aria-hidden />}
            title={
              <>
                <strong>{current.name || "SimpleFIN"}</strong> into {account.name}
              </>
            }
            action={pending.length > 1 ? <span className="help">{pending.length - 1} more after this</span> : undefined}
            cancelLabel="Skip this account"
            onCancel={() => setSkipped([...skipped, current.accountId])}
            onImport={(choices, count) => void save(current, choices, count)}
          />
          {current.balance !== null && (
            <p className="help">
              The bank&apos;s balance: {money(current.balance, { symbol: true })}
              {current.balanceDate && ` on ${formatDate(current.balanceDate)}`}. UrBudget&apos;s, before this import:{" "}
              {money(balances.get(account.id)?.balance ?? account.openingBalance, { symbol: true })}.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="import-lead">
            {imported
              ? `Imported ${imported} ${imported === 1 ? "transaction" : "transactions"}. They're waiting for your approval.`
              : "Nothing new to import."}
          </p>
          {onCategorize && left.ids.length > 0 && (
            <CategorizeOffer
              uncategorized={left}
              onCategorize={() => {
                close();
                onCategorize(left);
              }}
            />
          )}
          <ul className="bank-sync-summary">
            {reviews.map((r) => (
              <li key={r.accountId}>
                <strong>{name(r.accountId)}</strong>{" "}
                {r.error ?? (skipped.includes(r.accountId) ? "Skipped for now." : "Up to date.")}
              </li>
            ))}
          </ul>
          <div className="form-actions">
            <button className="primary" onClick={close}>
              Done
            </button>
          </div>
        </>
      )}
      {message && (
        <p role="status" className="import-result">
          {message}
        </p>
      )}
      {onAsk && about && problem && (
        <div className="import-assist needed">
          <MessageSquareText size={16} aria-hidden />
          <p>
            {allIn
              ? "Every new row from this card came in as money in. If these are purchases, the bank sends signs the other way round, and the assistant can check it with you."
              : "The assistant can look at this sync with you and say what to try."}
            <small>Opens the assistant with a question ready. Nothing is sent until you press Send.</small>
          </p>
          <button type="button" className="secondary small" onClick={() => onAsk(about, problem)}>
            Ask the assistant
          </button>
        </div>
      )}
      {synced && (
        <p className="help">
          Requests to SimpleFIN today: {synced.requestsToday} of {synced.dailyLimit}.
        </p>
      )}
    </div>
  );
}

/** Whether an account syncs with SimpleFIN. */
export const syncs = (a?: Account) => !!a?.simplefin && !a.archived;

/** An account's bank sync at a glance: where it syncs from, when, the bank's balance beside the budget's. */
export function BankSyncDetails({
  budget,
  account,
  balances,
  edit,
  onSync,
  onSettings,
  onAsk,
  close,
}: {
  budget: Budget;
  account: Account;
  balances: Map<string, Summary["accounts"][number]>;
  edit: (update: (draft: Budget) => void) => void;
  onSync: () => void;
  onSettings: () => void;
  onAsk?: () => void;
  close: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<SimpleFinStatus | null>(null);
  useEffect(() => {
    simplefin.status().then(setStatus, () => setStatus(null));
  }, []);
  const link = account.simplefin;
  if (!link) return null;
  const listed = status?.accounts.find((a) => a.id === link.id);
  const balance = balances.get(account.id)?.balance ?? account.openingBalance;
  const next = link.lastSync ? daysAgo(7, link.lastSync) : link.from;
  const org = listed?.org || link.org;
  const reversed =
    account.kind === "credit" && !!listed?.balance && !!balance && Math.sign(listed.balance) !== Math.sign(balance);
  const unlink = () => {
    edit((d) => {
      delete d.accounts.find((a) => a.id === account.id)!.simplefin;
    });
    close();
    toast({
      message: `${account.name} no longer syncs with its bank.`,
      action: {
        label: "Undo",
        onClick: () =>
          edit((d) => {
            d.accounts.find((a) => a.id === account.id)!.simplefin = link;
          }),
      },
    });
  };
  return (
    <div className="bank-sync-details">
      <dl>
        <dt>At the bank</dt>
        <dd>
          {listed?.name ?? link.name ?? "Bank account"}
          {org && <small className="bank-text">{org}</small>}
        </dd>
        <dt>Last synced</dt>
        <dd>{link.lastSync ? formatDate(link.lastSync) : "Not yet"}</dd>
        <dt>Next sync</dt>
        <dd>Brings in what posted from {formatDate(next)} on</dd>
        <dt>The bank&apos;s balance</dt>
        <dd>
          {listed?.balance != null
            ? `${money(listed.balance, { currency: listed.currency })}${listed.balanceDate ? ` on ${formatDate(listed.balanceDate)}` : ""}`
            : "Shown after a sync"}
        </dd>
        <dt>UrBudget&apos;s balance</dt>
        <dd>{money(balance, { symbol: true })}</dd>
        {account.kind === "credit" && (
          <>
            <dt>Card amounts</dt>
            <dd>{link.flipSigns ? "Reversed: purchases arrive as money in" : "As the bank sends them"}</dd>
          </>
        )}
        <dt>Connection</dt>
        <dd>
          {!status
            ? "Checking…"
            : status.connected
              ? `SimpleFIN Bridge · ${status.requestsToday} of ${status.dailyLimit} requests today`
              : "Not connected on this computer. Connect in Settings & data › Import."}
        </dd>
      </dl>
      {reversed && (
        <p className="notice">
          The bank&apos;s balance and UrBudget&apos;s have opposite signs. If the card&apos;s purchases came in as money
          in, turn on Purchases arrive as money in, in Bank sync settings.
        </p>
      )}
      {listed && listed.currency !== budget.currency && (
        <p className="notice error">
          This bank account is in {listed.currency ?? "a currency of its own"}, but this budget uses {budget.currency}.
        </p>
      )}
      {status?.messages.map((m) => (
        <p key={m} className="notice">
          {m}
        </p>
      ))}
      <div className="form-actions">
        <button className="text-button" onClick={unlink}>
          Unlink
        </button>
        <button className="secondary" onClick={onSettings}>
          Bank sync settings
        </button>
        {onAsk && (
          <button className="secondary" onClick={onAsk}>
            <MessageSquareText size={14} /> Ask the assistant
          </button>
        )}
        <button className="primary" disabled={!status?.connected} onClick={onSync}>
          <RefreshCw size={14} /> Sync now
        </button>
      </div>
    </div>
  );
}
