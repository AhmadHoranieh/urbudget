// The optional urbudget.app account and end-to-end encrypted sync, as the window sees them.
// Rust does the network, the encryption and the database work.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./bridge";
import type { SyncState } from "./useBudget";

/** A change both devices made differently, which sync asks about (see sync_merge.rs). */
export type SyncConflict = {
  /** What the answer is given under; the same from one sync to the next. */
  key: string;
  kind: "account" | "category" | "transaction" | "assignment" | "schedule" | "payee" | "payeeRule" | "monthNote" | "loan" | "budget" | "setting";
  /** The record's name: a category's, an account's, a transaction's payee. */
  label: string;
  /** What else tells the record apart: a transaction's date, account and amount; an assignment's month. */
  about: Record<string, unknown>;
  /** The field both changed, or null when one side deleted the record and the other edited it. */
  field: string | null;
  /** Each side's value; for a deleted record null, and `{ changed: [fields] }` for the edited one. */
  local: unknown;
  remote: unknown;
};
export type BudgetSync = {
  id: string;
  name: string;
  state: "synced" | "uploaded" | "downloaded" | "merged" | "conflict" | "cloud_only" | "local_only" | "waiting" | "update_app" | "error";
  device: string | null;
  updatedAt: string | null;
  message: string | null;
  /** For "conflict": what to choose. Empty when the versions couldn't be combined at all. */
  conflicts?: SyncConflict[];
  /** What a merge decided on its own, such as assignments made on both devices being added together. */
  notes?: string[];
};
export type SyncReport = {
  at: string;
  state: "ok" | "signed_out" | "locked" | "subscription_required" | "offline" | "error";
  message: string | null;
  budgets: BudgetSync[];
  openChanged: boolean;
};
export type CloudStatus = {
  /** The signed-in account. */
  email: string | null;
  /** What protects saved secrets (Keychain, Windows encrypted storage), or null when they last until the app closes. */
  credentialStore: string | null;
  sync: { unlocked: boolean; last: SyncReport | null };
  site: string;
};
export type Overview = {
  user: { id: string; email: string; createdAt: string };
  subscription: { status: string; renewsAt: string | null; endsAt: string | null } | null;
  sync: { active: boolean; budgets: number; bytes: number };
};

export const cloud = {
  status: () => invoke<CloudStatus>("cloud_status"),
  overview: () => invoke<Overview>("account_overview"),
  /** Emails a sign-in code; configured reviewers use the separately supplied access code. */
  start: (email: string) => invoke<{ ok: true; devCode?: string; reviewAccess?: boolean }>("account_start", { email }),
  verify: (email: string, code: string) => invoke<CloudStatus>("account_verify", { email, code }),
  signOut: () => invoke<CloudStatus>("account_sign_out"),
  deleteAccount: (confirm: string) => invoke<CloudStatus>("account_delete", { confirm }),
  /** Opens a page of urbudget.app in the browser, signed in when this computer is. */
  open: (next: string) => invoke<void>("account_open", { next }),
  syncNow: (openClean: boolean) => invoke<SyncReport>("sync_now", { openClean }),
  syncHasKey: () => invoke<boolean>("sync_has_key"),
  syncSetup: (passphrase: string) => invoke<{ created: boolean }>("sync_setup", { passphrase }),
  syncReset: (passphrase: string) => invoke<void>("sync_reset", { passphrase }),
  syncTrack: (ids: string[]) => invoke<void>("sync_track", { ids }),
  syncDownload: (id: string) => invoke<string>("sync_download", { id }),
  /** "merge" merges again with the answers in `choices`; "local" and "cloud" keep one whole version. */
  syncResolve: (id: string, keep: "merge" | "local" | "cloud", openClean: boolean, choices?: Record<string, "local" | "cloud">) =>
    invoke<SyncReport>("sync_resolve", { id, keep, openClean, choices: choices ?? null }),
  syncRemove: (id: string) => invoke<void>("sync_remove", { id }),
  syncLock: () => invoke<void>("sync_lock"),
};

const SYNC_EVERY = 5 * 60_000;
const AFTER_SAVE = 8_000;

/** What sync needs to know about the open budget. */
export type OpenBudget = {
  dirty: () => boolean;
  sync: SyncState;
  operation: string;
  /** Changes with every save. */
  token: string;
  fetchDatabase: () => Promise<void>;
};

/**
 * Account and sync state for the whole window. Syncs on start, every few minutes, when
 * the window comes back into focus, and shortly after each save, while signed in with sync
 * unlocked. A downloaded version of the open budget is loaded only when it has no unsaved edits.
 */
export function useCloud(open: OpenBudget) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const latest = useRef(open);
  latest.current = open;
  const statusRef = useRef(status);
  statusRef.current = status;
  const running = useRef<Promise<SyncReport | null> | null>(null);
  const lastRun = useRef(0);

  const refresh = useCallback(async () => {
    if (!desktop) return null;
    const next = await cloud.status();
    setStatus(next);
    return next;
  }, []);

  const syncNow = useCallback(async (): Promise<SyncReport | null> => {
    const current = statusRef.current;
    if (!desktop || !current?.email || !current.sync.unlocked) return null;
    if (running.current) return running.current;
    const work = async () => {
      setSyncing(true);
      lastRun.current = Date.now();
      try {
        const o = latest.current;
        const report = await cloud.syncNow(!o.dirty() && o.sync === "saved" && !o.operation);
        if (report.openChanged && !latest.current.dirty()) await latest.current.fetchDatabase();
        await refresh();
        return report;
      } catch {
        return null;
      } finally {
        setSyncing(false);
        running.current = null;
      }
    };
    running.current = work();
    return running.current;
  }, [refresh]);

  useEffect(() => {
    if (!desktop) return;
    void refresh().catch(() => {});
  }, [refresh]);

  // Waits for the open budget to load, so the first sync can also bring in its newer version.
  const ready = !!status?.email && !!status.sync.unlocked && !!open.token;
  useEffect(() => {
    if (!ready) return;
    void syncNow();
    const timer = setInterval(() => void syncNow(), SYNC_EVERY);
    const focus = () => {
      if (Date.now() - lastRun.current > 60_000) void syncNow();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [ready, syncNow]);

  // Shortly after each save, so other computers see changes within seconds.
  useEffect(() => {
    if (!ready || !open.token) return;
    const timer = setTimeout(() => void syncNow(), AFTER_SAVE);
    return () => clearTimeout(timer);
  }, [ready, open.token, syncNow]);

  return { status, setStatus, refresh, syncNow, syncing };
}
export type Cloud = ReturnType<typeof useCloud>;
