import { useSyncExternalStore } from "react";
import { today } from "./types";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
const currentMonth = () => today().slice(0, 7);

function schedule() {
  clearTimeout(timer);
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  // Browser timers cap at about 24 days; check daily too, including clock/time-zone changes.
  timer = setTimeout(refresh, Math.max(1, Math.min(nextMonth.getTime() - now.getTime(), 86_400_000)));
}
function refresh() {
  for (const listener of listeners) listener();
  if (listeners.size) schedule();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    }
  };
}

/** One calendar context for summaries and preview caches, without changing the viewed month. */
export function useCalculationMonth() {
  return useSyncExternalStore(subscribe, currentMonth, currentMonth);
}
