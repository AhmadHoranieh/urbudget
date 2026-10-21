import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Cloud as CloudIcon, CloudOff, LoaderCircle, Lock, RefreshCw } from "lucide-react";
import { cloud, type BudgetSync, type Cloud, type Overview } from "./cloud";
import { errorText, formatDate } from "./format";
import { Modal } from "./forms";
import { SyncConflicts } from "./SyncConflicts";
import { useToast } from "./ui";
import "./cloud.css";

/** "just now", "5 minutes ago", "3 hours ago", or the date. */
export function ago(iso: string | null | undefined) {
  if (!iso) return "";
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return formatDate(iso.slice(0, 10));
}

function Confirm({
  title,
  children,
  label,
  danger,
  action,
  close,
}: {
  title: string;
  children: ReactNode;
  label: string;
  danger?: boolean;
  action: () => Promise<void>;
  close: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} close={close}>
      {children}
      <div className="modal-actions">
        <button className="secondary" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          className={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await action();
              close();
            } catch (e) {
              toast({ message: errorText(e), tone: "error" });
              setBusy(false);
            }
          }}
        >
          {busy && <LoaderCircle size={14} className="spin" />} {label}
        </button>
      </div>
    </Modal>
  );
}

function DeleteAccount({ cloud: state }: { cloud: Cloud }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const email = state.status?.email ?? "";
  return <>
    <button className="secondary danger-text" onClick={() => { setConfirm(""); setError(""); setOpen(true); }}>Delete account</button>
    {open && <Modal title="Delete your UrBudget account?" close={() => { if (!busy) setOpen(false); }}>
      <p>This deletes your account and cloud budgets and stops subscription renewals. Budgets saved on your devices stay there. Purchase records may be retained as described in the privacy policy.</p>
      <label>Type {email} to confirm<input type="email" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="off" disabled={busy} /></label>
      {error && <p role="alert" className="notice error">{error}</p>}
      <div className="modal-actions">
        <button className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        <button className="danger" disabled={busy || !email || confirm.trim().toLowerCase() !== email.toLowerCase()} onClick={async () => {
          setBusy(true); setError("");
          try { state.setStatus(await cloud.deleteAccount(confirm)); setOpen(false); }
          catch (e) { setError(errorText(e)); }
          finally { setBusy(false); }
        }}>{busy ? "Deleting…" : "Delete account and cloud data"}</button>
      </div>
    </Modal>}
  </>;
}

function SignIn({ cloud: state }: { cloud: Cloud }) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [reviewAccess, setReviewAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => toast({ message: errorText(e), tone: "error" });
  const send = async () => {
    setBusy(true);
    try {
      const answer = await cloud.start(email);
      setReviewAccess(answer.reviewAccess === true);
      setCode(answer.reviewAccess ? "" : answer.devCode ?? "");
      setSent(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    try {
      state.setStatus(await cloud.verify(email, code));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="sign-in"
      onSubmit={(e) => {
        e.preventDefault();
        void (sent ? verify() : send());
      }}
    >
      {!sent ? (
        <label>
          Email
          <span className="inline-field">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" disabled={busy} required />
            <button className="primary" disabled={busy || !email.includes("@")}>
              {busy && <LoaderCircle size={14} className="spin" />} Email me a code
            </button>
          </span>
        </label>
      ) : (
        <label>
          {reviewAccess ? "Review access code" : `The 6-digit code we sent to ${email}`}
          <span className="inline-field">
            <input
              className="mono code-input"
              type={reviewAccess ? "password" : "text"}
              value={code}
              onChange={(e) => setCode(reviewAccess ? e.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128) : e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode={reviewAccess ? "text" : "numeric"}
              autoComplete={reviewAccess ? "off" : "one-time-code"}
              minLength={reviewAccess ? 24 : 6}
              maxLength={reviewAccess ? 128 : 6}
              placeholder={reviewAccess ? "Access code" : "123456"}
              spellCheck={false}
              autoFocus
            />
            <button className="primary" disabled={busy || (reviewAccess ? code.length < 24 : code.length !== 6)}>
              {busy && <LoaderCircle size={14} className="spin" />} Sign in
            </button>
            <button type="button" className="link-button" disabled={busy} onClick={() => { setSent(false); setCode(""); setReviewAccess(false); }}>
              Use another email
            </button>
          </span>
        </label>
      )}
      <small className="muted">
        {sent
          ? reviewAccess ? "Use the access code supplied with the app review instructions." : "It can take a minute to arrive. Not there? Check your Junk or Spam folder."
          : "No password: each time you sign in, we email you a code."}
      </small>
    </form>
  );
}

const BUDGET_STATES: Record<BudgetSync["state"], string> = {
  synced: "Synced",
  uploaded: "Synced",
  downloaded: "Updated from the cloud",
  merged: "Synced, changes from both combined",
  conflict: "Changed in two places",
  cloud_only: "In the cloud",
  local_only: `Only on this computer`,
  waiting: "Waiting to sync",
  update_app: "Needs a newer UrBudget",
  error: "Couldn't sync",
};

function Passphrase({ cloud: state, onDone }: { cloud: Cloud; onDone: (created: boolean) => void }) {
  const toast = useToast();
  const [exists, setExists] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void cloud.syncHasKey().then(setExists).catch((e) => toast({ message: errorText(e), tone: "error" }));
  }, []);
  if (exists === null) return <LoaderCircle size={16} className="spin" />;
  const mismatch = !exists && again.length > 0 && again !== passphrase;
  return (
    <form
      className="passphrase"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const { created } = await cloud.syncSetup(passphrase);
          await state.refresh();
          onDone(created);
        } catch (err) {
          toast({ message: errorText(err), tone: "error" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="help">
        {exists
          ? `Enter the sync passphrase you chose on your other computer. It decrypts your budgets here.`
          : `Choose a sync passphrase. Your budgets are encrypted with it on this computer before they're uploaded, so nobody else, including us, can read them. We never see it and can't recover it; if you forget it, you can reset sync from any computer that has your budgets.`}
      </p>
      <label>
        Sync passphrase
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete={exists ? "current-password" : "new-password"} minLength={8} required />
      </label>
      {!exists && (
        <label>
          Type it again
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-invalid={mismatch} />
          {mismatch && <small className="negative">The two don't match.</small>}
        </label>
      )}
      <div>
        <button className="primary" disabled={busy || passphrase.length < 8 || (!exists && again !== passphrase)}>
          {busy && <LoaderCircle size={14} className="spin" />} {exists ? "Unlock sync" : "Turn on sync"}
        </button>
      </div>
      {state.status?.credentialStore && (
        <small className="muted">This computer keeps the key in {state.status.credentialStore}, so you enter the passphrase once.</small>
      )}
    </form>
  );
}

/** Settings › Account & sync. */
export function SyncSettings({
  cloud: state,
  budgetId,
  isClean,
  openBudget,
}: {
  cloud: Cloud;
  budgetId: string;
  /** The open budget has no unsaved edits. */
  isClean: () => boolean;
  openBudget: (id: string) => Promise<void>;
}) {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const overviewRequest = useRef(0);
  const [confirm, setConfirm] = useState<null | { title: string; text: ReactNode; label: string; danger?: boolean; action: () => Promise<void> }>(null);
  const [resetting, setResetting] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [reviewing, setReviewing] = useState<BudgetSync | null>(null);
  const status = state.status;
  const email = status?.email;
  const currentEmail = useRef(email);
  currentEmail.current = email;
  const fail = (e: unknown) => toast({ message: errorText(e), tone: "error" });
  const loadOverview = useCallback(() => {
    if (!email) return;
    const request = ++overviewRequest.current;
    const current = () => request === overviewRequest.current && email === currentEmail.current;
    setOverviewError("");
    void cloud
      .overview()
      .then((next) => { if (current()) setOverview(next); })
      .catch((e) => { if (current()) setOverviewError(errorText(e)); });
  }, [email]);
  useEffect(() => {
    setOverview(null);
    setOverviewError("");
    loadOverview();
    // Coming back from the browser (after subscribing) shows the new plan.
    window.addEventListener("focus", loadOverview);
    return () => { overviewRequest.current++; window.removeEventListener("focus", loadOverview); };
  }, [loadOverview]);

  if (!status)
    return (
      <section className="panel">
        <h2>Account</h2>
        <LoaderCircle size={16} className="spin" />
      </section>
    );
  const report = status.sync.last;
  const subscribed = overview?.sync.active ?? report?.state === "ok";
  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await work();
      await state.syncNow();
    } catch (e) {
      fail(e);
    } finally {
      setBusyId("");
    }
  };

  const budgetRow = (b: BudgetSync) => (
    <div className="setting-row sync-budget" key={b.id}>
      <span>
        <strong>
          {b.name}
          {b.id === budgetId && <em className="muted"> · open</em>}
        </strong>
        <small className={`sync-state ${b.state}`}>
          {BUDGET_STATES[b.state]}
          {b.message
            ? ` · ${b.message}`
            : b.conflicts?.length
              ? ` · ${b.conflicts.length === 1 ? "1 change" : `${b.conflicts.length} changes`} to choose`
              : b.updatedAt && b.state !== "local_only"
                ? ` · last change ${ago(b.updatedAt)}${b.device ? ` from ${b.device}` : ""}`
                : ""}
        </small>
        {b.notes?.map((note) => (
          <small key={note} className="sync-note">
            {note}
          </small>
        ))}
      </span>
      <span className="sync-actions">
        {busyId === b.id && <LoaderCircle size={14} className="spin" />}
        {b.state === "local_only" && (
          <button className="secondary" disabled={!!busyId} onClick={() => void act(b.id, () => cloud.syncTrack([b.id]))}>
            Sync this budget
          </button>
        )}
        {b.state === "cloud_only" && (
          <button
            className="secondary"
            disabled={!!busyId}
            onClick={() =>
              void act(b.id, async () => {
                await cloud.syncDownload(b.id);
                toast({ message: `Downloaded “${b.name}”.`, action: { label: "Open it", onClick: () => void openBudget(b.id).catch(fail) } });
              })
            }
          >
            Download
          </button>
        )}
        {b.state === "conflict" && !!b.conflicts?.length && (
          <button className="secondary" disabled={!!busyId} onClick={() => setReviewing(b)}>
            Review
          </button>
        )}
        {b.state === "conflict" && !b.conflicts?.length && (
          <>
            <button
              className="secondary"
              disabled={!!busyId}
              onClick={() =>
                setConfirm({
                  title: `Keep this computer's version?`,
                  text: <p>“{b.name}” as it is here replaces the cloud copy. Your other computers get this version on their next sync.</p>,
                  label: `Keep this computer's`,
                  action: () => act(b.id, () => cloud.syncResolve(b.id, "local", isClean())),
                })
              }
            >
              Keep this computer's
            </button>
            <button
              className="secondary"
              disabled={!!busyId}
              onClick={() =>
                setConfirm({
                  title: "Use the cloud copy?",
                  text: <p>“{b.name}” here is replaced by the cloud copy{b.device ? ` from ${b.device}` : ""}. This computer's version is backed up first (Settings › Backup & export).</p>,
                  label: "Use the cloud copy",
                  action: () => act(b.id, () => cloud.syncResolve(b.id, "cloud", isClean())),
                })
              }
            >
              Use the cloud copy
            </button>
          </>
        )}
        {["synced", "uploaded", "downloaded", "merged", "waiting", "conflict", "cloud_only", "error"].includes(b.state) && (
          <button
            className="link-button"
            disabled={!!busyId}
            onClick={() =>
              setConfirm({
                title: `Stop syncing “${b.name}”?`,
                text: <p>Its cloud copy is deleted. The copies on your computers stay where they are.</p>,
                label: "Stop syncing",
                danger: true,
                action: () => act(b.id, () => cloud.syncRemove(b.id)),
              })
            }
          >
            Stop syncing
          </button>
        )}
      </span>
    </div>
  );

  return (
    <>
      <section className="panel">
        <h2>Account</h2>
        {status.email ? (
          <div className="setting-list">
            <div className="setting-row">
              <span>
                <strong>Signed in as {status.email}</strong>
                <small>
                  {status.credentialStore ? `The sign-in is kept in ${status.credentialStore}.` : "You'll sign in again next time you open UrBudget."}
                </small>
              </span>
              <span className="sync-actions">
                <button className="secondary" onClick={() => void cloud.open("/account/").catch(fail)}>
                  Manage account
                </button>
                <DeleteAccount cloud={state} />
                <button
                  className="secondary"
                  onClick={() =>
                    setConfirm({
                      title: "Sign out of UrBudget?",
                      text: <p>Sync stops on this computer and it forgets the sync key. Your budgets here stay as they are.</p>,
                      label: "Sign out",
                      action: async () => {
                        state.setStatus(await cloud.signOut());
                        setOverview(null);
                      },
                    })
                  }
                >
                  Sign out
                </button>
              </span>
            </div>
          </div>
        ) : (
          <>
            <p className="help">An account is optional: you need one only for sync. Budgeting never needs it.</p>
            <SignIn cloud={state} />
          </>
        )}
      </section>

      <section className="panel sync-panel">
        <div className="panel-title">
          <h2>
            <CloudIcon size={18} /> Sync
          </h2>
          {status.email && status.sync.unlocked && subscribed && (
            <button className="secondary" disabled={state.syncing} onClick={() => void state.syncNow()}>
              <RefreshCw size={14} className={state.syncing ? "spin" : ""} /> Sync now
            </button>
          )}
        </div>
        <p className="help">
          Keeps your budgets the same on all your computers. End-to-end encrypted: they're encrypted on your computer before
          upload, and only your sync passphrase opens them. $3/month, cancel anytime.
        </p>
        {!status.email ? (
          <p className="muted">Sign in above to use sync.</p>
        ) : overviewError && !overview ? (
          <p className="notice error">
            <CloudOff size={14} /> <span>{overviewError}</span>
            <button className="secondary" onClick={loadOverview}>
              Try again
            </button>
          </p>
        ) : !overview && !report ? (
          <LoaderCircle size={16} className="spin" />
        ) : !subscribed ? (
          <div className="plan-offer">
            <div>
              <strong className="plan-price">$3 a month</strong>
              <small>
                {overview?.subscription?.status === "canceled"
                  ? "Your sync plan has ended. Subscribe again to pick up where you left off."
                  : "Subscribe on urbudget.app, then come back here."}
              </small>
            </div>
            <span className="sync-actions">
              <button className="primary" onClick={() => void cloud.open("/account/?subscribe=1").catch(fail)}>
                Subscribe
              </button>
              <button className="link-button" onClick={loadOverview}>
                I've subscribed
              </button>
            </span>
          </div>
        ) : !status.sync.unlocked ? (
          <Passphrase
            cloud={state}
            onDone={(created) => {
              toast({
                message: created ? "Sync is on. Your budgets are uploading, encrypted." : `Sync is unlocked on this computer.`,
                tone: "success",
              });
              void state.syncNow();
            }}
          />
        ) : (
          <>
            {overview?.subscription && (
              <p className="muted plan-line">
                {overview.subscription.endsAt
                  ? `Your plan ends on ${formatDate(overview.subscription.endsAt.slice(0, 10))}.`
                  : overview.subscription.status === "past_due"
                    ? `The last payment didn't go through; sync keeps working while it's retried. Update your card under Manage account.`
                    : overview.subscription.renewsAt
                      ? `Renews on ${formatDate(overview.subscription.renewsAt.slice(0, 10))}.`
                      : ""}
              </p>
            )}
            {report && report.state !== "ok" && (
              <p className="notice">
                <span>
                  {report.state === "offline"
                    ? "Offline. Sync picks up when you're back online."
                    : report.state === "locked"
                      ? "Enter your sync passphrase to sync."
                      : report.message ?? "Sync couldn't finish."}
                </span>
              </p>
            )}
            <div className="setting-list">{report?.budgets.map(budgetRow)}</div>
            <p className="muted sync-footer">
              {report?.state === "ok" ? `Last synced ${ago(report.at)}.` : ""}{" "}
              <button className="link-button" onClick={() => setResetting(true)}>
                Reset passphrase…
              </button>{" "}
              <button
                className="link-button"
                onClick={() =>
                  setConfirm({
                    title: `Lock sync on this computer?`,
                    text: <p>This computer forgets the sync key and stops syncing until you enter the passphrase again.</p>,
                    label: "Lock",
                    action: async () => {
                      await cloud.syncLock();
                      await state.refresh();
                    },
                  })
                }
              >
                <Lock size={12} /> Lock on this computer
              </button>
            </p>
          </>
        )}
      </section>
      {confirm && (
        <Confirm title={confirm.title} label={confirm.label} danger={confirm.danger} action={confirm.action} close={() => setConfirm(null)}>
          {confirm.text}
        </Confirm>
      )}
      {resetting && <ResetPassphrase cloud={state} close={() => setResetting(false)} />}
      {reviewing && (
        <SyncConflicts
          budget={reviewing}
          close={() => setReviewing(null)}
          resolve={async (choices) => {
            setBusyId(reviewing.id);
            try {
              await cloud.syncResolve(reviewing.id, "merge", isClean(), choices);
              await state.refresh();
            } finally {
              setBusyId("");
            }
          }}
        />
      )}
    </>
  );
}

function ResetPassphrase({ cloud: state, close }: { cloud: Cloud; close: () => void }) {
  const toast = useToast();
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Choose a new sync passphrase" close={close}>
      <form
        className="passphrase"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await cloud.syncReset(passphrase);
            await state.refresh();
            void state.syncNow();
            toast({ message: `New passphrase set. This computer's budgets are uploading again.`, tone: "success" });
            close();
          } catch (err) {
            toast({ message: errorText(err), tone: "error" });
            setBusy(false);
          }
        }}
      >
        <p>
          The cloud copies made with the old passphrase are deleted, and this computer's budgets upload again. Your other
          computers keep their budgets and need the new passphrase to sync.
        </p>
        <label>
          New passphrase
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" minLength={8} required />
        </label>
        <label>
          Type it again
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="danger" disabled={busy || passphrase.length < 8 || passphrase !== again}>
            {busy && <LoaderCircle size={14} className="spin" />} Reset sync
          </button>
        </div>
      </form>
    </Modal>
  );
}
