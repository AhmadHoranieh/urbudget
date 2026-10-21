// Category and group edits, applied to an immer draft inside `edit(...)`.
// Groups are the `group` string on categories, plus their place in `groupOrder`
// (which also keeps groups that have no categories yet).
import { groupNames, orderedCategories } from "./categories";
import { money } from "./format";
import { id, type Budget, type Split } from "./types";

const fullCategoryOrder = (d: Budget) => (d.categoryOrder = orderedCategories(d).map((c) => c.id));
const fullGroupOrder = (d: Budget) => (d.groupOrder = groupNames(d, { empty: true }));

/** Typing again within this long, in the same category, adjusts the last move instead of adding one. */
const KEEP_TYPING = 2 * 60_000;

/**
 * Sets a category's Assigned for a month and logs the change as a move. Changes to the same
 * category in quick succession (typing a figure, then correcting it) stay one move.
 */
export function assignAmount(d: Budget, month: string, categoryId: string, amount: number, now = new Date()) {
  const existing = d.assignments.find((a) => a.categoryId === categoryId && a.month === month);
  const previous = existing?.amount ?? 0;
  if (previous === amount) return;
  if (existing) existing.amount = amount;
  else d.assignments.push({ month, categoryId, amount });
  const moves = (d.moneyMoves ??= []);
  const name = d.categories.find((c) => c.id === categoryId)?.name ?? categoryId;
  const last = moves.at(-1);
  const same = last?.kind === "assign" && last.month === month && last.changes?.length === 1 && last.changes[0].categoryId === categoryId;
  if (same && now.getTime() - Date.parse(last.at) < KEEP_TYPING) {
    const change = last.changes![0].amount + amount - previous;
    if (!change) {
      moves.pop();
      return;
    }
    last.at = now.toISOString();
    last.description = `Assigned ${money(amount - change)} → ${money(amount)} to ${name}`;
    last.changes![0].amount = change;
    return;
  }
  moves.push({
    at: now.toISOString(),
    month,
    description: `Assigned ${money(previous)} → ${money(amount)} to ${name}`,
    kind: "assign",
    changes: [{ categoryId, amount: amount - previous }],
  });
}

export function renameCategory(d: Budget, categoryId: string, name: string) {
  const c = d.categories.find((x) => x.id === categoryId);
  if (c && name.trim()) c.name = name.trim();
}

/** Adds a category at the end of `group` and returns its id. */
export function addCategory(d: Budget, group: string, name: string) {
  const order = fullCategoryOrder(d);
  const newId = id();
  const last = order.map((cid) => d.categories.find((c) => c.id === cid)!).filter((c) => c.group === group).at(-1);
  d.categories.push({ id: newId, name: name.trim(), group, target: 0 });
  order.splice(last ? order.indexOf(last.id) + 1 : order.length, 0, newId);
  // The new category makes its group known; a first-time group goes last.
  if (!(d.groupOrder ?? []).includes(group)) fullGroupOrder(d);
  return newId;
}

/** Adds an empty group at the end. Returns false if the name is taken. */
export function addGroup(d: Budget, name: string) {
  const trimmed = name.trim();
  if (!trimmed || groupNames(d, { empty: true }).includes(trimmed)) return false;
  fullGroupOrder(d).push(trimmed);
  return true;
}

/** Renames a group; renaming onto an existing group merges the two. */
export function renameGroup(d: Budget, from: string, to: string) {
  const name = to.trim();
  if (!name || name === from) return;
  const order = fullGroupOrder(d);
  for (const c of d.categories) if (c.group === from) c.group = name;
  const index = order.indexOf(from);
  d.groupOrder = order.includes(name) ? order.filter((g) => g !== from) : order.map((g, i) => (i === index ? name : g));
}

/** Deletes a group; its categories (if any) move to `moveTo`. */
export function deleteGroup(d: Budget, name: string, moveTo?: string) {
  const order = fullGroupOrder(d);
  if (d.categories.some((c) => c.group === name)) {
    if (!moveTo || moveTo === name) return;
    for (const c of d.categories) if (c.group === name) c.group = moveTo;
  }
  d.groupOrder = order.filter((g) => g !== name);
}

export function setHidden(d: Budget, categoryIds: string[], hidden: boolean) {
  for (const c of d.categories) if (categoryIds.includes(c.id)) c.hidden = hidden;
}

/**
 * Deletes a category. Its history moves to `replacement` (a category id, or null for Ready
 * to Assign): transaction and schedule splits, payee rules and loan terms are reassigned,
 * and its monthly assignments are added to the replacement's (dropped for Ready to Assign).
 */
export function deleteCategory(d: Budget, categoryId: string, replacement: string | null) {
  const target = d.categories.find((c) => c.id === categoryId);
  if (!target || target.paymentAccountId || replacement === categoryId) return;
  // Moved to Unassigned on purpose, its spending doesn't then ask for a category (uncategorized.ts).
  const move = (s: Split) => {
    s.categoryId = replacement;
    if (replacement === null) s.unassigned = true;
  };
  for (const t of d.transactions) for (const s of t.splits) if (s.categoryId === categoryId) move(s);
  for (const s of d.schedules ?? []) for (const part of s.transaction.splits) if (part.categoryId === categoryId) move(part);
  for (const r of d.payeeRules ?? []) if (r.categoryId === categoryId) r.categoryId = replacement;
  // A loan's details belong to its account, so losing the payment category only unpairs it.
  for (const l of d.loans ?? []) if (l.categoryId === categoryId) l.categoryId = replacement ?? "";
  const moved = d.assignments.filter((a) => a.categoryId === categoryId);
  d.assignments = d.assignments.filter((a) => a.categoryId !== categoryId);
  const into = d.categories.find((c) => c.id === replacement)?.name;
  if (replacement)
    for (const a of moved) {
      const existing = d.assignments.find((x) => x.categoryId === replacement && x.month === a.month);
      if (existing) existing.amount += a.amount;
      else d.assignments.push({ month: a.month, categoryId: replacement, amount: a.amount });
      // The replacement's moves show where the extra came from.
      if (a.amount)
        (d.moneyMoves ??= []).push({
          at: new Date().toISOString(),
          month: a.month,
          description: `Merged ${target.name} into ${into ?? "another category"}`,
          kind: "merge",
          detail: target.name,
          changes: [{ categoryId: replacement, amount: a.amount }],
        });
    }
  d.categories = d.categories.filter((c) => c.id !== categoryId);
  if (d.categoryOrder) d.categoryOrder = d.categoryOrder.filter((x) => x !== categoryId);
}

/** Moves a category into `group`, before `beforeId` (or to the end of the group). */
export function moveCategory(d: Budget, categoryId: string, group: string, beforeId: string | null) {
  const c = d.categories.find((x) => x.id === categoryId);
  if (!c || categoryId === beforeId) return;
  const order = fullCategoryOrder(d).filter((x) => x !== categoryId);
  c.group = group;
  let index = beforeId ? order.indexOf(beforeId) : -1;
  if (index < 0) {
    const inGroup = order.filter((x) => d.categories.find((y) => y.id === x)?.group === group);
    index = inGroup.length ? order.indexOf(inGroup[inGroup.length - 1]) + 1 : order.length;
  }
  order.splice(index, 0, categoryId);
  d.categoryOrder = order;
  if (!(d.groupOrder ?? []).includes(group)) fullGroupOrder(d);
}

/** Moves a group before `before` (or to the end). */
export function moveGroup(d: Budget, name: string, before: string | null) {
  if (name === before) return;
  const order = fullGroupOrder(d).filter((g) => g !== name);
  const index = before ? order.indexOf(before) : -1;
  order.splice(index < 0 ? order.length : index, 0, name);
  d.groupOrder = order;
}

/** Moves a category one place up or down among visible categories, crossing into the next group. */
export function stepCategory(d: Budget, categoryId: string, delta: -1 | 1) {
  const c = d.categories.find((x) => x.id === categoryId);
  if (!c) return;
  const groups = groupNames(d, { empty: true });
  const visible = (g: string) => orderedCategories(d).filter((x) => x.group === g && !x.hidden && x.id !== categoryId);
  const siblings = orderedCategories(d).filter((x) => x.group === c.group && !x.hidden);
  const index = siblings.findIndex((x) => x.id === categoryId);
  const next = siblings[index + delta];
  if (next) return moveCategory(d, categoryId, c.group, delta < 0 ? next.id : (siblings[index + 2]?.id ?? null));
  const neighbour = groups[groups.indexOf(c.group) + delta];
  if (!neighbour) return;
  // Into the adjacent group: last place when moving up, first place when moving down.
  moveCategory(d, categoryId, neighbour, delta < 0 ? null : (visible(neighbour)[0]?.id ?? null));
}
