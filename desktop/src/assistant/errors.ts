import { invoke, isTauri } from "@tauri-apps/api/core";

/** The message and stack of anything thrown, as text. */
export function describe(error: unknown, where = ""): string {
  const e = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  return where ? `${e}\n${where}` : e;
}

/** Writes an error to errors.log in the app's data folder, so it can be read after a crash. */
export function logError(error: unknown, where = "") {
  if (!isTauri()) return;
  void invoke("assistant_log_error", { message: describe(error, where).slice(0, 20_000) }).catch(() => {});
}

let installed = false;
/** Logs errors nothing else caught. */
export function installErrorLog() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => logError(e.error ?? e.message, "window error"));
  window.addEventListener("unhandledrejection", (e) => logError(e.reason, "unhandled rejection"));
}
