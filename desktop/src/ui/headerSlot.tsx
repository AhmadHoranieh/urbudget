import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The page header has a slot just after its title for the page's own controls (the report
 * groups): App provides the slot's element, and a page portals into it. Undefined when there is
 * no header around the page at all, as when a test renders a page on its own.
 */
export const HeaderSlotElement = createContext<HTMLElement | null | undefined>(undefined);

/** Puts its children in the page header after the title; with no header around it, in place. */
export function HeaderSlot({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlotElement);
  if (slot === undefined) return <>{children}</>;
  return slot ? createPortal(children, slot) : null;
}
