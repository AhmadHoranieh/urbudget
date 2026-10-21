import type { Account, Budget, Category, Transaction } from "./types";

// Mirrors src-tauri/src/patch.rs. Budgets are produced with structural sharing
// (immer), so an unchanged record keeps its identity and diffing compares references.
type Keyed = { id: string };
export type Collection<T> = { upsert: T[]; delete: string[]; order?: string[] };
type Assignment = Budget["assignments"][number];
export type Patch = {
  schemaVersion?: number;
  name?: string;
  currency?: string;
  accounts?: Collection<Account>;
  categories?: Collection<Category>;
  transactions?: Collection<Transaction>;
  assignments?: {
    upsert: Assignment[];
    delete: { month: string; categoryId: string }[];
  };
  extras?: { set: Record<string, unknown>; delete: string[] };
};
const core = new Set([
  "schemaVersion",
  "name",
  "currency",
  "accounts",
  "categories",
  "transactions",
  "assignments",
]);
const collections = ["accounts", "categories", "transactions"] as const;

function diffCollection<T extends Keyed>(
  before: T[],
  after: T[],
): Collection<T> | undefined {
  if (before === after) return undefined;
  const previous = new Map(before.map((x) => [x.id, x]));
  const present = new Set(after.map((x) => x.id));
  const upsert = after.filter((x) => previous.get(x.id) !== x);
  const removed = before.filter((x) => !present.has(x.id)).map((x) => x.id);
  const implied = [
    ...before.filter((x) => present.has(x.id)).map((x) => x.id),
    ...after.filter((x) => !previous.has(x.id)).map((x) => x.id),
  ];
  const moved = implied.some((id, i) => after[i].id !== id);
  if (!upsert.length && !removed.length && !moved) return undefined;
  return {
    upsert,
    delete: removed,
    ...(moved ? { order: after.map((x) => x.id) } : {}),
  };
}
function applyCollection<T extends Keyed>(items: T[], change: Collection<T>) {
  const gone = new Set(change.delete);
  const next = gone.size ? items.filter((x) => !gone.has(x.id)) : [...items];
  const index = new Map(next.map((x, i) => [x.id, i]));
  for (const item of change.upsert) {
    const i = index.get(item.id);
    if (i === undefined) {
      index.set(item.id, next.length);
      next.push(item);
    } else next[i] = item;
  }
  if (!change.order) return next;
  const rank = new Map(change.order.map((id, i) => [id, i]));
  const last = Number.MAX_SAFE_INTEGER;
  return next
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (rank.get(a.x.id) ?? last) - (rank.get(b.x.id) ?? last) || a.i - b.i)
    .map(({ x }) => x);
}
const assignmentKey = (a: { month: string; categoryId: string }) =>
  `${a.month}\u0000${a.categoryId}`;

/** Changes that turn `before` into `after`, or null when they are the same. */
export function diff(before: Budget, after: Budget): Patch | null {
  if (before === after) return null;
  const patch: Patch = {};
  if (before.schemaVersion !== after.schemaVersion)
    patch.schemaVersion = after.schemaVersion;
  if (before.name !== after.name) patch.name = after.name;
  if (before.currency !== after.currency) patch.currency = after.currency;
  for (const key of collections) {
    const change = diffCollection<Keyed>(before[key], after[key]);
    if (change) (patch as Record<string, unknown>)[key] = change;
  }
  if (before.assignments !== after.assignments) {
    const previous = new Map(before.assignments.map((a) => [assignmentKey(a), a]));
    const present = new Set(after.assignments.map(assignmentKey));
    const upsert = after.assignments.filter(
      (a) => previous.get(assignmentKey(a))?.amount !== a.amount,
    );
    const removed = before.assignments
      .filter((a) => !present.has(assignmentKey(a)))
      .map(({ month, categoryId }) => ({ month, categoryId }));
    if (upsert.length || removed.length)
      patch.assignments = { upsert, delete: removed };
  }
  const was = before as Record<string, unknown>,
    is = after as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  for (const key of Object.keys(is))
    if (!core.has(key) && is[key] !== undefined && is[key] !== was[key])
      set[key] = is[key];
  const removed = Object.keys(was).filter(
    (key) => !core.has(key) && was[key] !== undefined && is[key] === undefined,
  );
  if (Object.keys(set).length || removed.length)
    patch.extras = { set, delete: removed };
  return Object.keys(patch).length ? patch : null;
}

/** Returns a new budget with `patch` applied; records it does not mention are reused. */
export function apply(budget: Budget, patch: Patch): Budget {
  const next = { ...budget } as Record<string, unknown> & Budget;
  if (patch.schemaVersion !== undefined) next.schemaVersion = patch.schemaVersion;
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.currency !== undefined) next.currency = patch.currency;
  if (patch.accounts) next.accounts = applyCollection(budget.accounts, patch.accounts);
  if (patch.categories)
    next.categories = applyCollection(budget.categories, patch.categories);
  if (patch.transactions)
    next.transactions = applyCollection(budget.transactions, patch.transactions);
  if (patch.assignments) {
    const gone = new Set(patch.assignments.delete.map(assignmentKey));
    const list = budget.assignments.filter((a) => !gone.has(assignmentKey(a)));
    const index = new Map(list.map((a, i) => [assignmentKey(a), i]));
    for (const a of patch.assignments.upsert) {
      const i = index.get(assignmentKey(a));
      if (i === undefined) {
        index.set(assignmentKey(a), list.length);
        list.push(a);
      } else list[i] = { ...list[i], amount: a.amount };
    }
    next.assignments = list;
  }
  if (patch.extras) {
    for (const key of patch.extras.delete) delete next[key];
    Object.assign(next, patch.extras.set);
  }
  return next;
}
