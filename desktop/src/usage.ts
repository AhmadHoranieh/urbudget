// Anonymous usage counts (urbudget_services::usage in Rust). A few seconds after the app starts,
// and every hour while it's open, Rust counts this copy as in use on urbudget.app when the day,
// week or month is new since it was last counted; otherwise it sends nothing. Nothing identifies
// the copy. Settings → Privacy & data turns it off.
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./bridge";
import { getPref } from "./prefs";

const FIRST = 10_000;
const HOUR = 3600_000;

export function useUsageCounts() {
  useEffect(() => {
    if (!desktop) return;
    // Offline, nothing is marked counted, so the next hour tries again.
    const report = () => void (getPref("usageCounts") && invoke("report_usage").catch(() => {}));
    const first = window.setTimeout(report, FIRST);
    const hourly = window.setInterval(report, HOUR);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(hourly);
    };
  }, []);
}
