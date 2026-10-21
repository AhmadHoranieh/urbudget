import type { Transaction } from "./types";

type Added = Pick<Transaction, "id" | "date" | "createdAt">;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The order transactions were added in, oldest first: by date, then by when each was added
 * (`createdAt`; one without, from before the app kept it or from YNAB, counts as older). Two
 * without a time keep the order the register always gave them, by id, so upgrading doesn't
 * reshuffle a day or its running balances. Sort a list in the budget's own order with it: sorting
 * is stable, so ones added at the same moment keep the order they're saved in. Mirrors
 * added_order in domain.rs.
 */
export const byAdded = (a: Added, b: Added) =>
  compare(a.date, b.date) ||
  (a.createdAt || b.createdAt
    ? // A missing time compares as "", before every time.
      compare(a.createdAt || "", b.createdAt || "")
    : a.id.localeCompare(b.id));

/**
 * `list` (in the budget's order) newest first, as the register shows it: the order they were
 * added in, reversed. `of` gives each item's transaction. Returns a new array.
 */
export const newestFirst = <T>(list: readonly T[], of: (item: T) => Added): T[] =>
  [...list].sort((a, b) => byAdded(of(a), of(b))).reverse();
