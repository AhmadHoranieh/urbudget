// The first time a live demo is half on screen and the page has stopped scrolling, a purple
// cursor clicks it once and then leaves the rest to you. A picture never answers a click, so
// watching one answered is what says the demo is real. It plays once per demo per visit, gives
// way the moment you scroll on or reach for the demo yourself, and is a tap instead of a cursor
// on a touch screen. With reduced motion it never plays; the bar over the demo still says what to
// do.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const touch = matchMedia("(hover: none)").matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ARROW = '<svg viewBox="0 0 22 24" width="22" height="24"><path d="M3 3l7.4 18.6 2.6-7.5 7.6-2.7z"/></svg>';
// The sticky header covers the top of the screen.
const TOP = 72;

/** Wholly on screen and clear of the header, including inside a row that scrolls sideways. */
export function inView(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.top >= TOP && r.bottom <= innerHeight - 8 && r.left >= 8 && r.right <= innerWidth - 8;
}

const centre = (el, fx = 0.5, fy = 0.55) => {
  const r = el.getBoundingClientRect();
  return [r.left + r.width * fx, r.top + r.height * fy];
};

/**
 * plan() describes the demonstration just before it plays, or returns nothing to skip it:
 *   target, fx, fy  what the cursor clicks, and where on it (fractions of its box)
 *   act()           what that click does
 *   pause           how long the cursor waits after the click, in ms
 *   next            where it points afterwards, saying "Your turn" (or a function that finds it
 *                   once act() has run); arrive([x, y], el) runs when it gets there
 *   leave()         tidies up once it has gone
 */
export function showOnce(root, name, plan) {
  if (reduceMotion || !root) return;
  const key = `urbudget:shown:${name}`;
  try {
    if (sessionStorage.getItem(key)) return;
  } catch {
    // Without storage it can play once per page view instead.
  }

  let taken = false;
  let visible = false;
  let timer = 0;
  // The visitor reached for the demo first. A click counts but a finger dragging the page past
  // doesn't, and a real mouse move counts but the moves a browser makes up when the page scrolls
  // under a resting mouse don't.
  const take = () => {
    taken = true;
    clearTimeout(timer);
  };
  root.addEventListener("click", take);
  root.addEventListener("keydown", take);
  root.addEventListener("focusin", take);
  root.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse" && Math.abs(event.movementX) + Math.abs(event.movementY) > 2) take();
  });

  // Starts once the page has been still for a moment with the demo in view.
  const arm = () => {
    clearTimeout(timer);
    if (visible && !taken) timer = setTimeout(start, 900);
  };
  const observer = new IntersectionObserver(
    ([entry]) => {
      // Half of it, or most of the screen when it's taller than that.
      visible = entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= innerHeight * 0.6;
      arm();
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] },
  );
  observer.observe(root);
  addEventListener("scroll", arm, { passive: true });

  function start() {
    if (!visible || taken || document.hidden) return;
    const p = plan();
    // Its target scrolled off or hidden in a sideways row: the next scroll tries again.
    if (!p || !inView(p.target)) return;
    observer.disconnect();
    removeEventListener("scroll", arm);
    try {
      sessionStorage.setItem(key, "1");
    } catch {
      // Already handled above.
    }
    void play(p);
  }

  async function play(p) {
    let scrolled = false;
    const onScroll = () => (scrolled = true);
    addEventListener("scroll", onScroll, { passive: true });
    const stopped = () => taken || scrolled || document.hidden;
    const wait = async (ms) => {
      await sleep(ms);
      if (stopped()) throw new Error("stopped");
    };

    const ghost = document.createElement("div");
    ghost.className = touch ? "ghost is-touch" : "ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.innerHTML = `${ARROW}<span class="ghost-tag">Your turn</span>`;
    document.body.append(ghost);
    const moveTo = ([x, y], ms = 0) => {
      ghost.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.3, 0.6, 0.2, 1), opacity 0.2s ease` : "";
      ghost.style.transform = `translate(${x - 3}px, ${y - 3}px)`;
    };
    const tap = ([x, y]) => {
      const ring = document.createElement("span");
      ring.className = "ghost-tap";
      ring.setAttribute("aria-hidden", "true");
      Object.assign(ring.style, { left: `${x}px`, top: `${y}px` });
      document.body.append(ring);
      setTimeout(() => ring.remove(), 600);
    };

    try {
      const at = centre(p.target, p.fx, p.fy);
      if (touch) {
        moveTo(at);
      } else {
        // In from below and to the right, where a hand on a mouse would come from.
        moveTo([Math.min(innerWidth - 40, at[0] + 120), Math.min(innerHeight - 40, at[1] + 90)]);
        ghost.getBoundingClientRect();
        ghost.classList.add("is-on");
        await wait(250);
        moveTo(at, 750);
        await wait(800);
        ghost.classList.add("is-down");
      }
      tap(at);
      p.act();
      await wait(140);
      ghost.classList.remove("is-down");
      await wait(p.pause ?? 500);

      let next = typeof p.next === "function" ? p.next() : p.next;
      if (next && !inView(next)) next = null;
      const label = ghost.querySelector(".ghost-tag");
      const point = next ? centre(next, p.nextFx, p.nextFy) : at;
      let there = point;
      // The label flips to the cursor's left when it would run off the screen.
      let flip = point[0] + 14 + label.offsetWidth > innerWidth - 8;
      let say = true;
      if (touch) {
        // With no cursor to point, the label sits beside the next control, on whichever side has
        // room, or doesn't show.
        const r = next?.getBoundingClientRect();
        const room = label.offsetWidth + 18;
        flip = Boolean(r) && r.left - room > 8;
        say = Boolean(r) && (flip || r.right + room < innerWidth - 8);
        if (say) there = [flip ? r.left : r.right, r.top + r.height / 2];
      }
      moveTo(there, touch ? 0 : 650);
      await wait(touch ? 0 : 680);
      if (next) p.arrive?.(point, next);
      ghost.classList.toggle("is-flip", flip);
      ghost.classList.add("is-on");
      ghost.classList.toggle("is-saying", say);
      await wait(1900);
    } catch {
      // Stopped: the visitor scrolled on or took over.
    }
    removeEventListener("scroll", onScroll);
    ghost.classList.remove("is-on");
    p.leave?.();
    setTimeout(() => ghost.remove(), 300);
  }
}
