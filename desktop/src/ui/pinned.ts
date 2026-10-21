import { useCallback, useRef } from "react";

/**
 * For a page that scrolls as one, with a block at its top that stays put (the summary and
 * toolbar) while the rows scroll under it. Attach `ref` to that block, a direct child of the
 * scroll area: the area gets `--pinned` set to the block's height, so a table header can stick
 * just below it, and `height` holds it for code that scrolls rows into view.
 */
export function usePinned() {
  const height = useRef(0);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const update = () => {
      height.current = el.offsetHeight;
      el.parentElement?.style.setProperty("--pinned", `${height.current}px`);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  return { ref, height };
}
