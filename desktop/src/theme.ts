import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./bridge";

export type Theme = "system" | "light" | "dark";
const KEY = "lb:theme";
const read = (): Theme => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};

/** App-wide colour theme. "system" follows the operating system. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* the choice just isn't remembered */
    }
    // Native title bar and scrollbars follow too.
    if (desktop) void getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => {});
  }, [theme]);
  return [theme, setTheme] as const;
}
