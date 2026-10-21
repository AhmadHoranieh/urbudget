// Automatic updates (tauri-plugin-updater). The app looks for a newer version a few seconds
// after it starts and once a day, and installs one only when asked, after saving. Rust checks
// the package's signature against the updater key in tauri.conf.json before installing it.
// Microsoft Store copies use Windows' package-update APIs, never the standalone installer.
// A failed channel lookup never enables another updater.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { desktop } from "./bridge";
import { errorText } from "./format";

const FIRST_CHECK = 8_000;
const DAY = 24 * 3600_000;
export type UpdateChannel = "direct" | "microsoftStore";

export type UpdateState = {
  /** A newer version than this one, when the last check found one. */
  // Windows reports package availability, not a reliable target version.
  available: { version: string | null; notes: string } | null;
  phase: "idle" | "checking" | "downloading" | "installing";
  /** While downloading: the share received, when the size is known. */
  progress: number | null;
  /** The last check found nothing newer. */
  current: boolean;
  channel: UpdateChannel | null;
  error: string | null;
};

export function useUpdates() {
  const [state, setState] = useState<UpdateState>({
    available: null,
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

  /** Checks this copy's update provider. Offline, a background check changes nothing. */
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
          setState((s) => ({
            ...s,
            available: available
              ? {
                  version: null,
                  notes:
                    "An update is available from Microsoft Store. Your budget is saved before Windows downloads and installs it.",
                }
              : null,
            current: !available,
            error: null,
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
          current: !next,
          error: null,
        }));
      } catch (e) {
        if (manual) setState((s) => ({ ...s, error: errorText(e) }));
      } finally {
        busy.current = false;
        setState((s) => ({ ...s, phase: "idle" }));
      }
    },
    [identify],
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
   * Direct downloads leave the window usable. `withSavedBudget` must save and hold the edit
   * lock through installation/restart. Store requests can close the app while downloading,
   * so the entire Windows request runs under that lock.
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
        if (!fromStore && update && downloaded.current !== update) {
          setState((s) => ({
            ...s,
            phase: "downloading",
            progress: null,
            error: null,
          }));
          let total = 0;
          let received = 0;
          let shown = 0;
          await update.download((event) => {
            if (event.event === "Started")
              total = event.data.contentLength ?? 0;
            if (event.event !== "Progress" || !total) return;
            received += event.data.chunkLength;
            const share = Math.min(1, received / total);
            if (share - shown >= 0.01 || share === 1) {
              shown = share;
              setState((s) => ({ ...s, progress: share }));
            }
          });
          downloaded.current = update;
        }
        setState((s) => ({
          ...s,
          phase: "installing",
          progress: null,
          error: null,
        }));
        await withSavedBudget(async () => {
          if (fromStore) {
            const installed = await invoke<boolean>("install_store_update");
            if (!installed) {
              storeUpdate.current = false;
              setState((s) => ({ ...s, available: null, current: true }));
              return;
            }
          } else {
            // Installing uses up the download, even when it fails.
            downloaded.current = null;
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
    [],
  );

  const openStore = useCallback(async () => {
    if (busy.current) return;
    try {
      await invoke("open_update_store");
    } catch (e) {
      setState((s) => ({ ...s, error: errorText(e) }));
    }
  }, []);

  return { ...state, check: lookup, install, openStore };
}
export type Updates = ReturnType<typeof useUpdates>;
