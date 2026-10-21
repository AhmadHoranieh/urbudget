import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Popover, type Anchor, type Placement } from "./Popover";

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
    }
  | "separator";

/** A list of actions in a popover, navigable with the arrow keys. */
export function Menu({
  open,
  onClose,
  anchor,
  items,
  label,
  placement = "bottom-start",
}: {
  open: boolean;
  onClose: () => void;
  anchor: Anchor;
  items: MenuItem[];
  label: string;
  placement?: Placement;
}) {
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const entries = [
      ...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])"),
    ];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? entries[(index + 1) % entries.length]
        : e.key === "ArrowUp"
          ? entries[(index - 1 + entries.length) % entries.length]
          : e.key === "Home"
            ? entries[0]
            : e.key === "End"
              ? entries[entries.length - 1]
              : undefined;
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement={placement} role="menu" label={label} className="menu">
      <div onKeyDown={move}>
        {items.map((item, i) =>
          item === "separator" ? (
            <div key={i} className="menu-separator" role="separator" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={`menu-item${item.danger ? " danger" : ""}`}
              aria-disabled={item.disabled || undefined}
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <span className="menu-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </button>
          ),
        )}
      </div>
    </Popover>
  );
}

/** State for a right-click menu: spread `onContextMenu` on the target, render `<Menu anchor={at}>`. */
export function useContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return {
    at,
    open: (e: MouseEvent) => {
      e.preventDefault();
      setAt({ x: e.clientX, y: e.clientY });
    },
    /** Opens below a button instead of at the pointer. */
    openAt: (x: number, y: number) => setAt({ x, y }),
    close: () => setAt(null),
  };
}
