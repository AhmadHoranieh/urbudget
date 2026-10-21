import { useEffect, useRef, useState } from "react";

/**
 * `value`, except that a passing state (one `passing` says yes to) shows only once it has lasted
 * `ms`; until then the last steady value stays on screen. A save that takes 50 ms then doesn't
 * flash a dialog, a spinner or a greyed-out button. Once a passing state has lasted, later
 * changes within it (a progress message, say) show straight away.
 */
export function useSteady<T>(value: T, passing: (v: T) => boolean, ms = 400): T {
  const isPassing = passing(value);
  const [lasted, setLasted] = useState(false);
  const steady = useRef(value);
  if (!isPassing) steady.current = value;
  useEffect(() => {
    if (!isPassing) {
      setLasted(false);
      return;
    }
    const timer = setTimeout(() => setLasted(true), ms);
    return () => clearTimeout(timer);
  }, [isPassing, ms]);
  return isPassing && !lasted ? steady.current : value;
}
