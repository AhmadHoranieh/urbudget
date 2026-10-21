import type { Budget, Transaction } from "./types";

/**
 * Payee rules are the bank names a payee goes by: each says that a bank payee containing
 * `match` is the payee `payee` (or, with no payee, keeps the bank's name and only sets a
 * category). The rules run in Rust (workflows.rs); these mirror them, to say what a change
 * would do before making it.
 */
export type PayeeRule = NonNullable<Budget["payeeRules"]>[number];

/** Bank text as rules read it: lower case, with punctuation and runs of spaces as one space. */
export const normalizePayee = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{N}]+/gu, " ")
    .trim();

/** What the bank file said, for a transaction imported from one, else its payee. */
export const bankText = (t: Transaction) => (t.importedPayee?.trim() ? t.importedPayee : t.payee);

type Patterns = { rule: PayeeRule; pattern: string; length: number }[];
const patterns = (rules: PayeeRule[] = []): Patterns =>
  rules.map((rule) => {
    const pattern = normalizePayee(rule.match);
    return { rule, pattern, length: [...pattern].length };
  });
function best(list: Patterns, text: string) {
  const padded = ` ${normalizePayee(text)}`;
  let found: PayeeRule | null = null;
  let length = 0;
  for (const p of list)
    if (p.pattern && p.length > length && padded.includes(` ${p.pattern}`)) {
      found = p.rule;
      length = p.length;
    }
  return found;
}

/**
 * The rule for some bank text: of the rules whose text it contains (ignoring case and
 * punctuation, from the start of a word), the longest. Rules of the same length go in list order.
 */
export const payeeRule = (b: Pick<Budget, "payeeRules">, text: string) => best(patterns(b.payeeRules), text);

/** The category an import gives spending no rule categorized: "Uncategorized", which isn't a real choice. */
export const placeholder = (b: Pick<Budget, "categories">, id: string) =>
  id === "local-uncategorized" ||
  b.categories.some((c) => c.id === id && (c.name === "Uncategorized" || c.name === "Uncategorized Transactions"));

/**
 * What running the rules again would do to a transaction already in the budget, or null for
 * nothing. With `only`, just where its best rule is one of these.
 */
export function reapplied(b: Budget, t: Transaction, only?: Set<string>, list = patterns(b.payeeRules)) {
  if (t.transferAccountId) return null;
  const rule = best(list, bankText(t));
  if (only && !(rule && only.has(rule.id))) return null;
  const name = rule?.payee.trim() || null;
  const payee = name ?? t.payee;
  const [split, ...rest] = t.splits;
  const before = split?.categoryId ?? null;
  let categoryId = before;
  const account = b.accounts.find((a) => a.id === t.accountId);
  const onBudget = !!account && account.kind !== "tracking" && account.onBudget !== false;
  if (split && !rest.length && onBudget && !split.transferAccountId) {
    // An inflow without a category is in Ready to Assign, which may be on purpose.
    const empty = before === null ? t.amount < 0 : placeholder(b, before);
    const fallback =
      name || t.importedPayee !== undefined ? b.payees?.find((p) => p.name === payee)?.categoryId : null;
    const pick = rule?.categoryId ?? fallback;
    if (empty && pick && !placeholder(b, pick) && b.categories.some((c) => c.id === pick)) categoryId = pick;
  }
  return payee !== t.payee || categoryId !== before ? { payee, categoryId } : null;
}

/** How many transactions running the rules again would change. */
export function ruleChanges(b: Budget, only?: Set<string>) {
  const list = patterns(b.payeeRules);
  return b.transactions.reduce((n, t) => n + (reapplied(b, t, only, list) ? 1 : 0), 0);
}

/** Words card processors and banks put before the merchant's name. */
const PREFIXES = new Set([
  "pos",
  "debit",
  "credit",
  "card",
  "purchase",
  "checkcard",
  "visa",
  "ach",
  "recurring",
  "pending",
  "preauth",
  "authorized",
  "sq",
  "tst",
  "sp",
  "pp",
  "paypal",
]);
const digits = (word: string) => (word.match(/\p{N}/gu) ?? []).length;

/**
 * The part of some bank text worth matching on: without the processor's prefix ("SQ *",
 * "PURCHASE AUTHORIZED ON 09/14"), and up to the first store number or date, at most three
 * words. Words in `payee` are kept, so "PAYPAL" stays in a rule for PayPal.
 */
export function suggestMatch(raw: string, payee = "") {
  const keep = new Set(normalizePayee(payee).split(" "));
  const words = normalizePayee(raw).split(" ").filter(Boolean);
  const prefix = (i: number) =>
    !keep.has(words[i]) &&
    (PREFIXES.has(words[i]) || digits(words[i]) >= 2 || (words[i] === "on" && words[i - 1] === "authorized"));
  let i = 0;
  while (i < words.length - 1 && prefix(i)) i++;
  const picked: string[] = [];
  for (const w of words.slice(i)) {
    if (digits(w) >= 2 || picked.length === 3) break;
    picked.push(w);
  }
  return picked.join(" ") || words.join(" ");
}

/**
 * A rule that makes `raw` come out as `payee` from now on, or null if the rules already do:
 * the suggested text, or the bank's whole text when an existing rule would win over that.
 */
export function ruleFor(b: Pick<Budget, "payeeRules">, raw: string, payee: string): PayeeRule | null {
  const name = payee.trim();
  if (!raw.trim() || !name || payeeRule(b, raw)?.payee.trim() === name) return null;
  for (const match of [suggestMatch(raw, name), normalizePayee(raw)]) {
    const rule: PayeeRule = { id: "", match, payee: name, categoryId: null };
    if (match && payeeRule({ payeeRules: [...(b.payeeRules ?? []), rule] }, raw) === rule) return rule;
  }
  return null;
}

/** After a transaction from a bank file is saved under a new payee, the rule that would remember it. */
export function learnFromRename(before: Budget, saved: Transaction) {
  const prev = before.transactions.find((t) => t.id === saved.id);
  const raw = prev?.importedPayee;
  if (!prev || !raw || saved.transferAccountId || prev.payee === saved.payee) return null;
  return ruleFor(before, raw, saved.payee);
}
