// Automatic updates (tauri-plugin-updater). The app looks for a newer version a few seconds
// after it starts and once a day, downloads it in the background, and installs it at a moment
// that interrupts nothing: when UrBudget is closed, or once it has sat unused in the background
// with everything saved, reopening it afterwards. Installing by hand stays available.
// Rust checks the package's signature against the updater key in tauri.conf.json before
// installing it. Microsoft Store copies use Windows' package-update APIs, never the standalone
// installer. A failed channel lookup never enables another updater.
import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { desktop } from "./bridge";
import { errorText } from "./format";

const FIRST_CHECK = 8_000;
const DAY = 24 * 3600_000;
/** How long UrBudget must sit unused in the background before it updates itself. */
export const IDLE_BEFORE_UPDATE = 15 * 60_000;
export type UpdateChannel = "direct" | "microsoftStore";

export type UpdateState = {
  /** A newer version than this one, when the last check found one. */
  // Windows reports package availability, not a reliable target version.
  available: { version: string | null; notes: string } | null;
  /**
   * The update is downloaded and installs without asking: on closing UrBudget (Store copies)
   * or once it sits unused. A Store copy whose owner turned off the Store's automatic updates,
   * or that's on a metered connection, needs their go-ahead instead.
   */
  ready: boolean;
  phase: "idle" | "checking" | "downloading" | "installing";
  /** While downloading: the share received, when the size is known. */
  progress: number | null;
  /** The last check found nothing newer. */
  current: boolean;
  channel: UpdateChannel | null;
  error: string | null;
};

const storeNotes = {
  ready: "Downloaded from Microsoft Store.",
  consent: "An update is available from Microsoft Store. Your budget is saved before Windows downloads and installs it.",
};

export function useUpdates() {
  const [state, setState] = useState<UpdateState>({
    available: null,
    ready: false,
    phase: "idle",
    progress: null,
    current: false,
    channel: null,
    error: null,
  });
  const found = useRef<Update | null>(null);
  const downloaded = useRef<Update | null>(null);
  const busy = useRef(false);
  const lastCheck = useRef(0);
  const channel = useRef<UpdateChannel | null>(null);
  const channelRequest = useRef<Promise<UpdateChannel> | null>(null);
  const storeUpdate = useRef(false);
  /** Windows has the Store update downloaded and installs it without asking. */
  const silentStore = useRef(false);
  const identify = useCallback(async () => {
    if (channel.current) return channel.current;
    if (!channelRequest.current) {
      channelRequest.current = invoke<UpdateChannel>("update_channel")
        .then((value) => {
          if (!["direct", "microsoftStore"].includes(value))
            throw new Error(
              "Couldn't identify this app's update channel. Try checking again.",
            );
          channel.current = value;
          setState((s) => ({ ...s, channel: value }));
          return value;
        })
        .finally(() => {
          channelRequest.current = null;
        });
    }
    return channelRequest.current;
  }, []);

  /** Downloads a standalone update, showing its progress; a finished download is kept. */
  const fetchUpdate = useCallback(async (update: Update) => {
    if (downloaded.current === update) return;
    setState((s) => ({ ...s, phase: "downloading", progress: null }));
    let total = 0;
    let received = 0;
    let shown = 0;
    await update.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event !== "Progress" || !total) return;
      received += event.data.chunkLength;
      const share = Math.min(1, received / total);
      if (share - shown >= 0.01 || share === 1) {
        shown = share;
        setState((s) => ({ ...s, progress: share }));
      }
    });
    downloaded.current = update;
  }, []);

  /**
   * Checks this copy's update provider and downloads what it finds. Offline, a background
   * check changes nothing; a failed background download leaves the update to install by hand.
   */
  const lookup = useCallback(
    async (manual = false) => {
      if (!desktop || busy.current) return;
      busy.current = true;
      lastCheck.current = Date.now();
      if (manual) setState((s) => ({ ...s, phase: "checking", error: null }));
      try {
        const source = await identify();
        if (source === "microsoftStore") {
          const available = await invoke<boolean>("check_store_update");
          storeUpdate.current = available;
          silentStore.current = false;
          setState((s) => ({
            ...s,
            available: available ? { version: null, notes: storeNotes.consent } : null,
            ready: false,
            current: !available,
            error: null,
          }));
          if (!available) return;
          setState((s) => ({ ...s, phase: "downloading", progress: null }));
          let outcome = "consent";
          try {
            outcome = await invoke<string>("download_store_update");
          } catch (e) {
            if (manual) setState((s) => ({ ...s, error: errorText(e) }));
          }
          if (outcome === "none") {
            storeUpdate.current = false;
            setState((s) => ({ ...s, available: null, current: true }));
            return;
          }
          silentStore.current = outcome === "ready";
          setState((s) => ({
            ...s,
            ready: silentStore.current,
            available: { version: null, notes: silentStore.current ? storeNotes.ready : storeNotes.consent },
          }));
          return;
        }
        const next = await check({ timeout: 30_000 });
        const previous = found.current;
        found.current = next;
        if (previous && previous !== next)
          void previous.close().catch(() => {});
        setState((s) => ({
          ...s,
          available: next
            ? { version: next.version, notes: next.body?.trim() ?? "" }
            : null,
          ready: !!next && downloaded.current === next,
          current: !next,
          error: null,
        }));
        if (!next) return;
        try {
          await fetchUpdate(next);
          if (found.current === next) setState((s) => ({ ...s, ready: true }));
        } catch (e) {
          // Installing by hand downloads it again.
          if (manual) setState((s) => ({ ...s, error: errorText(e) }));
        }
      } catch (e) {
        if (manual) setState((s) => ({ ...s, error: errorText(e) }));
      } finally {
        busy.current = false;
        setState((s) => ({ ...s, phase: "idle", progress: null }));
      }
    },
    [identify, fetchUpdate],
  );

  useEffect(() => {
    if (!desktop) return;
    // Keep retries scheduled even if initial channel identification fails.
    void identify().catch(() => {});
    const first = setTimeout(() => void lookup(), FIRST_CHECK);
    // Hourly, so a computer that slept through the day still checks once it wakes.
    const hourly = setInterval(() => {
      if (Date.now() - lastCheck.current >= DAY) void lookup();
    }, 3600_000);
    const focus = () => {
      if (Date.now() - lastCheck.current >= DAY) void lookup();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearTimeout(first);
      clearInterval(hourly);
      window.removeEventListener("focus", focus);
    };
  }, [identify, lookup]);

  /**
   * Installs the update and reopens UrBudget on the new version. `withSavedBudget` must save
   * and hold the edit lock through installation/restart. Store requests can close the app
   * while downloading, so the entire Windows request runs under that lock.
   */
  const install = useCallback(
    async (
      withSavedBudget: (install: () => Promise<void>) => Promise<void>,
    ) => {
      const update = found.current;
      const fromStore = channel.current === "microsoftStore";
      if (
        busy.current ||
        (fromStore
          ? !storeUpdate.current
          : !update || channel.current !== "direct")
      )
        return;
      busy.current = true;
      try {
        if (!fromStore && update) await fetchUpdate(update);
        setState((s) => ({
          ...s,
          phase: "installing",
          progress: null,
          error: null,
        }));
        await withSavedBudget(async () => {
          if (fromStore) {
            // A downloaded update installs without a prompt; otherwise Windows asks first.
            // Either way Windows closes UrBudget to replace it and opens it again.
            const installed = silentStore.current
              ? await invoke<boolean>("apply_store_update", { relaunch: true })
              : await invoke<boolean>("install_store_update");
            if (!installed) {
              storeUpdate.current = false;
              silentStore.current = false;
              setState((s) => ({ ...s, available: null, ready: false, current: true }));
              return;
            }
          } else {
            // Installing uses up the download, even when it fails.
            downloaded.current = null;
            setState((s) => ({ ...s, ready: false }));
            await update!.install();
          }
          await invoke("restart_app");
        });
      } catch (e) {
        setState((s) => ({ ...s, error: errorText(e) }));
        throw e;
      } finally {
        busy.current = false;
        setState((s) => ({ ...s, phase: "idle", progress: null }));
      }
    },
    [fetchUpdate],
  );

  /**
   * For closing the window, after the budget is saved: a Store update Windows has downloaded
   * installs now, without reopening UrBudget. Resolves false when there's nothing to install
   * or Windows wouldn't; the window closes either way.
   */
  const installOnExit = useCallback(async () => {
    if (channel.current !== "microsoftStore" || !silentStore.current || !storeUpdate.current || busy.current)
      return false;
    busy.current = true;
    try {
      return await invoke<boolean>("apply_store_update", { relaunch: false });
    } catch {
      return false;
    } finally {
      busy.current = false;
    }
  }, []);

  const openStore = useCallback(async () => {
    if (busy.current) return;
    try {
      await invoke("open_update_store");
    } catch (e) {
      setState((s) => ({ ...s, error: errorText(e) }));
    }
  }, []);

  return { ...state, check: lookup, install, installOnExit, openStore };
}
export type Updates = ReturnType<typeof useUpdates>;

/** Calls `notify` once with the new version when this launch is the first after an update. */
export function useUpdatedNotice(notify: (version: string) => void) {
  const latest = useRef(notify);
  latest.current = notify;
  useEffect(() => {
    if (!desktop) return;
    void getVersion()
      .then((version) => {
        let previous: string | null = null;
        try {
          previous = localStorage.getItem("lb:version");
          localStorage.setItem("lb:version", version);
        } catch {
          return;
        }
        if (previous && previous !== version) latest.current(version);
      })
      .catch(() => {});
  }, []);
}

/**
 * Installs a downloaded update by itself once UrBudget has sat unused in the background for
 * IDLE_BEFORE_UPDATE and `safe()` says nothing would be lost, so nobody has to remember to
 * update. `install` saves first and reopens the app on the new version.
 */
export function useAutomaticUpdate(ready: boolean, safe: () => boolean, install: () => void) {
  const lastActive = useRef(Date.now());
  const latest = useRef({ safe, install });
  latest.current = { safe, install };
  useEffect(() => {
    const active = () => {
      lastActive.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "wheel", "focus"] as const;
    for (const name of events) window.addEventListener(name, active, true);
    return () => {
      for (const name of events) window.removeEventListener(name, active, true);
    };
  }, []);
  useEffect(() => {
    if (!desktop || !ready) return;
    const timer = setInterval(() => {
      if (document.hasFocus() || Date.now() - lastActive.current < IDLE_BEFORE_UPDATE) return;
      if (!latest.current.safe()) return;
      // A failed attempt waits for another quiet spell rather than retrying every minute.
      lastActive.current = Date.now();
      latest.current.install();
    }, 60_000);
    return () => clearInterval(timer);
  }, [ready]);
}
