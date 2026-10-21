import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { api } from "./bridge";
import { normalizePayee, ruleChanges, ruleFor } from "./bankNames";
import { payeeIndex } from "./payees";
import { newestFirst } from "./order";
import { CategoryPicker, Combobox, PayeeInput, READY_TO_ASSIGN, Tabs, useToast, useVirtualRows } from "./ui";
import { errorText, formatDate, money, tone } from "./format";
import { Cols, tableWidth, useColumns } from "./ui/columns";
import { id, type Budget } from "./types";
import "./pages.css";

type Props = {
  budget: Budget;
  edit: (fn: (b: Budget) => void) => void;
  transform: (fn: (b: Budget) => Promise<Budget>) => Promise<void>;
  undo?: () => void;
};
type Rule = NonNullable<Budget["payeeRules"]>[number];

/** After a rename or merge, keep one entry per payee name, preferring one with a default category. */
export function tidyPayees(b: Budget, name: string): Budget {
  const same = (b.payees ?? []).filter((p) => p.name === name);
  if (same.length < 2) return b;
  const keep = same.find((p) => p.categoryId) ?? same[0];
  return { ...b, payees: (b.payees ?? []).filter((p) => p.name !== name || p === keep) };
}

/** What renaming `from` would change: transactions (incl. split lines), schedules and rules. */
export function payeeUsage(b: Budget, from: string) {
  const transactions = b.transactions.filter((t) => t.payee === from || t.splits.some((s) => s.payee === from)).length;
  const schedules = (b.schedules ?? []).filter(
    (s) => s.transaction.payee === from || s.transaction.splits.some((p) => p.payee === from),
  ).length;
  const rules = (b.payeeRules ?? []).filter((r) => r.payee === from).length;
  return { transactions, schedules, rules };
}
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** Runs the payee rules again over earlier transactions (only `ruleIds`, if given), saying how many changed. */
function useReapply({ transform, undo }: Pick<Props, "transform" | "undo">) {
  const toast = useToast();
  return async (count: number, ruleIds?: string[]) => {
    try {
      await transform((b) => api.action(b, { type: "reapplyPayeeRules", ...(ruleIds && { ruleIds }) }));
      toast({ message: `Updated ${plural(count, "transaction")}.`, action: undo ? { label: "Undo", onClick: undo } : undefined });
    } catch (e) {
      toast({ message: errorText(e), tone: "error" });
    }
  };
}
const describeUsage = (u: ReturnType<typeof payeeUsage>) =>
  [plural(u.transactions, "transaction"), u.schedules && plural(u.schedules, "schedule"), u.rules && plural(u.rules, "rule")]
    .filter(Boolean)
    .join(", ");

export function Payees(props: Props) {
  const { budget } = props;
  const [tab, setTab] = useState<"payees" | "rules">("payees");
  const payees = useMemo(() => payeeIndex(budget), [budget.transactions, budget.payees, budget.categories]);
  return (
    <div className="page payees-page">
      <div className="page-intro">
        <p>Tidy up payee names, give payees a default category, and tell UrBudget the names your bank uses for them.</p>
      </div>
      <Tabs<"payees" | "rules">
        label="Payees and rules"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "payees", label: "Payees", count: payees.length },
          { id: "rules", label: "Import rules", count: budget.payeeRules?.length ?? 0 },
        ]}
      />
      {tab === "payees" ? <PayeeManager {...props} payees={payees} /> : <RuleList {...props} />}
    </div>
  );
}

function PayeeManager({ budget, edit, transform, undo, payees }: Props & { payees: ReturnType<typeof payeeIndex> }) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? payees.filter((p) => p.name.toLowerCase().includes(q)) : payees;
  }, [payees, search]);
  // The list and a payee's details, the first payee's until another is picked.
  const current = payees.find((p) => p.name === selected) ?? shown[0] ?? null;
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const [cursor, setCursor] = useState(0);
  const rowHeight = 48;
  const inView = useVirtualRows(list, shown.length, rowHeight);
  const activeIndex = Math.min(cursor, shown.length - 1);
  useEffect(() => {
    setCursor(0);
    if (list.current) {
      list.current.scrollTop = 0;
      list.current.dispatchEvent(new Event("scroll"));
    }
  }, [search]);
  const categoryName = useMemo(() => new Map(budget.categories.map((c) => [c.id, c.name])), [budget.categories]);
  const accountName = useMemo(() => new Map(budget.accounts.map((a) => [a.id, a.name])), [budget.accounts]);
  const recent = useMemo(
    () =>
      current
        ? newestFirst(
            budget.transactions.filter((t) => t.payee === current.name),
            (t) => t,
          )
        : [],
    [budget.transactions, current?.name],
  );
  const total = recent.reduce((n, t) => n + t.amount, 0);
  const stored = budget.payees?.find((p) => p.name === current?.name);
  const pick = (name: string) => {
    setSelected(name);
    setNewName("");
    setMergeInto(null);
  };
  const undoable = (message: string) => toast({ message, action: undo ? { label: "Undo", onClick: undo } : undefined });
  const rename = async (from: string, to: string, merging: boolean) => {
    const target = to.trim();
    if (!target || target === from) return;
    const usage = describeUsage(payeeUsage(budget, from));
    setBusy(true);
    try {
      await transform(async (b) => tidyPayees(await api.action(b, { type: "renamePayee", from, to: target }), target));
      pick(target);
      undoable(merging ? `Merged ${from} into ${target} (${usage}).` : `Renamed ${from} to ${target}.`);
    } catch (e) {
      toast({ message: errorText(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const setDefault = (name: string, categoryId: string | null) => {
    edit((d) => {
      const list = (d.payees ??= []);
      const entry = list.find((p) => p.name === name);
      if (entry) entry.categoryId = categoryId;
      else if (categoryId) list.push({ id: id(), name, categoryId });
    });
    undoable(
      categoryId
        ? `${name} now defaults to ${categoryId === READY_TO_ASSIGN ? "Unassigned" : categoryName.get(categoryId)}.`
        : `${name} no longer has a default category.`,
    );
  };
  const exists = (name: string) => payees.some((p) => p.name === name.trim());
  const usage = current ? payeeUsage(budget, current.name) : null;
  return (
    <div className="payee-manager">
      <section className="payee-list panel flush" aria-label="Payees">
        <label className="search">
          <Search size={15} />
          <input aria-label="Search payees" placeholder="Search payees" value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); list.current?.focus(); } }} />
        </label>
        <ul ref={list} role="listbox" aria-label="Payee list" tabIndex={0}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          onKeyDown={(e) => {
            const moves: Record<string, number> = { ArrowDown: activeIndex + 1, ArrowUp: activeIndex - 1, Home: 0, End: shown.length - 1 };
            if (e.key in moves && shown.length) {
              e.preventDefault();
              const next = Math.max(0, Math.min(shown.length - 1, moves[e.key]));
              setCursor(next);
              const el = e.currentTarget;
              const height = el.clientHeight || 600;
              if (next * rowHeight < el.scrollTop) el.scrollTop = next * rowHeight;
              else if ((next + 1) * rowHeight > el.scrollTop + height) el.scrollTop = (next + 1) * rowHeight - height;
              el.dispatchEvent(new Event("scroll"));
            } else if ((e.key === "Enter" || e.key === " ") && shown[activeIndex]) {
              e.preventDefault(); pick(shown[activeIndex].name);
            }
          }}>
          {inView.before > 0 && <li role="presentation" aria-hidden className="payee-spacer" style={{ height: inView.before }} />}
          {shown.slice(inView.start, inView.end).map((p, offset) => (
            <li
              key={p.name}
              id={`${listId}-${inView.start + offset}`}
              role="option"
              aria-posinset={inView.start + offset + 1}
              aria-setsize={shown.length}
              aria-selected={p.name === current?.name}
              className={`${p.name === current?.name ? "selected" : ""}${inView.start + offset === activeIndex ? " cursor" : ""}`}
              style={{ height: rowHeight }}
              onClick={() => { setCursor(inView.start + offset); pick(p.name); }}
            >
              <span>{p.name}</span>
              <small>
                {p.count ? `${plural(p.count, "transaction")} · ${formatDate(p.last)}` : "Not used yet"}
                {p.fixed && " · default set"}
              </small>
            </li>
          ))}
          {inView.after > 0 && <li role="presentation" aria-hidden className="payee-spacer" style={{ height: inView.after }} />}
          {!shown.length && <li className="muted empty">No payees match.</li>}
        </ul>
      </section>
      {current ? (
        <section className="payee-detail panel" aria-label={`Payee ${current.name}`}>
          <div className="payee-head">
            <h2>{current.name}</h2>
            <span className="muted">
              {plural(current.count, "transaction")}
              {current.count > 0 && <> · total <span className={tone(total)}>{money(total)}</span></>}
            </span>
          </div>

          <div className="field">
            <span>Default category</span>
            <div className="with-clear">
              <CategoryPicker
                budget={budget}
                label="Default category"
                value={stored?.categoryId ?? null}
                onChange={(categoryId) => setDefault(current.name, categoryId)}
                readyToAssign="Unassigned (new money)"
                includeHidden
                placeholder={
                  current.categoryId !== undefined && !current.fixed
                    ? `Last used: ${current.categoryId ? categoryName.get(current.categoryId) : "Unassigned"}`
                    : "No default"
                }
              />
              {stored?.categoryId && (
                <button className="icon-button" aria-label="Clear default category" onClick={() => setDefault(current.name, null)}>
                  <X size={14} />
                </button>
              )}
            </div>
            <small className="help">Filled in when you enter a transaction for this payee. Without one, the category you used last time is suggested.</small>
          </div>

          <BankNames budget={budget} edit={edit} transform={transform} undo={undo} payee={current.name} />

          <form
            className="field"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void rename(current.name, newName, exists(newName));
            }}
          >
            <span>Rename</span>
            <div className="inline-form">
              <input aria-label="New name" placeholder={current.name} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={200} />
              <button className="secondary" disabled={busy || !newName.trim() || newName.trim() === current.name}>
                <Pencil size={14} /> {exists(newName) && newName.trim() !== current.name ? "Merge" : "Rename"}
              </button>
            </div>
            {exists(newName) && newName.trim() !== current.name && (
              <small className="help warning-text">{newName.trim()} already exists, so this merges the two.</small>
            )}
          </form>

          <div className="field">
            <span>Merge into another payee</span>
            <div className="inline-form">
              <Combobox
                label="Merge into"
                placeholder="Choose a payee"
                options={payees.filter((p) => p.name !== current.name).map((p) => ({ id: p.name, label: p.name }))}
                value={mergeInto}
                onChange={setMergeInto}
              />
              <button
                className="secondary"
                disabled={busy || !mergeInto}
                onClick={() => mergeInto && void rename(current.name, mergeInto, true)}
              >
                Merge
              </button>
            </div>
            {mergeInto && usage && (
              <small className="help">
                Moves {describeUsage(usage)} from {current.name} to {mergeInto}.
              </small>
            )}
          </div>

          <div className="payee-recent">
            <h3>Recent transactions</h3>
            {recent.length ? (
              <table className="data-table">
                <tbody>
                  {recent.slice(0, 6).map((t) => (
                    <tr key={t.id}>
                      <td>{formatDate(t.date)}</td>
                      <td className="muted">{accountName.get(t.accountId)}</td>
                      <td>
                        {t.splits.length > 1
                          ? `Split (${t.splits.length})`
                          : (categoryName.get(t.splits[0]?.categoryId ?? "") ?? "Unassigned")}
                      </td>
                      <td className={`num ${tone(t.amount)}`}>{money(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No transactions yet.</p>
            )}
          </div>
        </section>
      ) : (
        <section className="panel empty-state compact">
          <h2>No payees yet</h2>
          <p>Payees appear here as you enter transactions.</p>
        </section>
      )}
    </div>
  );
}

/**
 * The names a payee goes by in bank files: the rules that give it this name, the bank text on
 * its transactions that no rule covers yet, and a way to apply them to earlier transactions.
 */
function BankNames({ budget, edit, transform, undo, payee }: Props & { payee: string }) {
  const toast = useToast();
  const reapply = useReapply({ transform, undo });
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const rules = useMemo(() => (budget.payeeRules ?? []).filter((r) => r.payee === payee), [budget.payeeRules, payee]);
  const categoryName = (id: string) => budget.categories.find((c) => c.id === id)?.name ?? "Deleted category";
  // Bank text on this payee's transactions that the rules would name something else.
  const seen = useMemo(() => {
    const found = new Map<string, { raw: string; match: string }>();
    for (const t of budget.transactions) {
      const raw = t.importedPayee?.trim();
      if (t.payee !== payee || !raw || found.has(normalizePayee(raw))) continue;
      const rule = ruleFor(budget, raw, payee);
      if (rule) found.set(normalizePayee(raw), { raw, match: rule.match });
    }
    return [...found.values()].slice(0, 5);
  }, [budget.transactions, budget.payeeRules, payee]);
  const pending = useMemo(
    () => (rules.length ? ruleChanges(budget, new Set(rules.map((r) => r.id))) : 0),
    [budget.transactions, budget.payeeRules, budget.payees, rules],
  );
  const add = (match: string) => {
    const taken = (budget.payeeRules ?? []).find((r) => normalizePayee(r.match) === normalizePayee(match));
    if (taken)
      return setError(
        taken.payee === payee
          ? `“${match}” is already one of ${payee}'s bank names.`
          : `“${match}” is already a rule${taken.payee ? ` for ${taken.payee}` : ""}. Change it on the Import rules tab.`,
      );
    const rule = { id: id(), match, payee, categoryId: null };
    edit((d) => void (d.payeeRules ??= []).push(rule));
    setText("");
    setError("");
    toast({ message: `Bank payees with “${match}” are now named ${payee}.`, action: undo ? { label: "Undo", onClick: undo } : undefined });
  };
  const remove = (ruleId: string, match: string) => {
    edit((d) => {
      d.payeeRules = (d.payeeRules ?? []).filter((r) => r.id !== ruleId);
    });
    toast({ message: `Removed “${match}” from ${payee}.`, action: undo ? { label: "Undo", onClick: undo } : undefined });
  };
  return (
    <div className="field bank-names">
      <span>Bank names</span>
      {rules.length > 0 && (
        <ul className="bank-name-list" aria-label={`Bank names for ${payee}`}>
          {rules.map((r) => (
            <li key={r.id}>
              <span>“{r.match}”</span>
              {r.categoryId && <small className="muted">{categoryName(r.categoryId)}</small>}
              <button className="icon-button" aria-label={`Remove bank name ${r.match}`} onClick={() => remove(r.id, r.match)}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="inline-form"
        aria-label="Add a bank name"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (text.trim()) add(text.trim());
        }}
      >
        <input
          aria-label="Bank name"
          placeholder="Text the bank uses, e.g. AMZN MKTP"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={200}
        />
        <button className="secondary" disabled={!text.trim()}>
          <Plus size={14} /> Add
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {seen.length > 0 && (
        <ul className="bank-seen" aria-label="Seen in bank files">
          {seen.map((s) => (
            <li key={s.raw}>
              <span className="muted" title="As the bank file wrote it">
                {s.raw}
              </span>
              <button className="link-button" onClick={() => add(s.match)}>
                Add “{s.match}”
              </button>
            </li>
          ))}
        </ul>
      )}
      {pending > 0 && (
        <button
          className="secondary bank-apply"
          onClick={() =>
            void reapply(
              pending,
              rules.map((r) => r.id),
            )
          }
        >
          Apply to {plural(pending, "earlier transaction")}
        </button>
      )}
      <small className="help">
        Bank files name the same place in different ways. A bank payee that contains one of these, ignoring case and
        punctuation, is named {payee}.
      </small>
    </div>
  );
}

function RuleEditor({
  budget,
  initial,
  onSave,
  onCancel,
}: {
  budget: Budget;
  initial?: Rule;
  onSave: (rule: Rule) => void;
  onCancel?: () => void;
}) {
  const [match, setMatch] = useState(initial?.match ?? "");
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [category, setCategory] = useState<string | null>(initial?.categoryId ?? null);
  const [error, setError] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!match.trim()) return setError("Enter the text to look for in the bank's payee.");
    if (!payee.trim() && !category) return setError("Choose a new name, a category, or both.");
    onSave({ id: initial?.id ?? id(), match: match.trim(), payee: payee.trim(), categoryId: category });
    if (!initial) {
      setMatch("");
      setPayee("");
      setCategory(null);
    }
    setError("");
  };
  return (
    <form className="rule-editor" onSubmit={submit} aria-label={initial ? "Edit rule" : "New rule"}>
      <label>
        When the bank payee contains
        <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="e.g. CARREFOUR" autoFocus={!!initial} />
      </label>
      <div className="field">
        <span>Rename to</span>
        <PayeeInput budget={budget} label="Rename to" placeholder="Keep the bank's name" value={payee} onChange={setPayee} />
      </div>
      <div className="field">
        <span>Category</span>
        <div className="with-clear">
          <CategoryPicker budget={budget} value={category} onChange={setCategory} label="Rule category" placeholder="Leave uncategorized" />
          {category && (
            <button type="button" className="icon-button" aria-label="No category" onClick={() => setCategory(null)}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="rule-editor-actions">
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="primary">
          {initial ? "Save rule" : (
            <>
              <Plus size={14} /> Add rule
            </>
          )}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function RuleList({ budget, edit, transform, undo }: Props) {
  const toast = useToast();
  const reapply = useReapply({ transform, undo });
  const [editing, setEditing] = useState<string | null>(null);
  const rules = budget.payeeRules ?? [];
  const pending = useMemo(() => ruleChanges(budget), [budget.transactions, budget.payeeRules, budget.payees]);
  const columns = useColumns("rules", { match: 240, payee: 240, category: 220 });
  const colWidths = [48, columns.widths.match, columns.widths.payee, columns.widths.category, null, 96];
  const categoryName = (id: string | null) => (id ? (budget.categories.find((c) => c.id === id)?.name ?? "Deleted category") : "—");
  return (
    <div className="rule-list">
      <section className="panel">
        <h2>New rule</h2>
        <p className="help">
          Rules apply to new transactions, whether imported from a bank file or entered by hand. A rule matches when
          the bank's payee contains its text, ignoring case and punctuation; when several match, the longest wins. It
          renames the payee and fills in the category if there's none: the rule's, or else the payee's default.
        </p>
        <RuleEditor budget={budget} onSave={(rule) => edit((d) => void (d.payeeRules ??= []).push(rule))} />
      </section>
      {pending > 0 && (
        <div className="rule-apply">
          <span>
            The rules would rename or categorize {plural(pending, "transaction")} you already have.
          </span>
          <button className="secondary" onClick={() => void reapply(pending)}>
            Apply to {plural(pending, "transaction")}
          </button>
        </div>
      )}
      {rules.length ? (
        <div className="panel flush table-scroll">
          <table className="data-table fixed rules-table" style={{ minWidth: tableWidth(colWidths) }}>
            <Cols widths={colWidths} />
            <thead>
              <tr>
                <th>#</th>
                <th>Bank payee contains{columns.grip("match", "Bank payee contains")}</th>
                <th>Rename to{columns.grip("payee", "Rename to")}</th>
                <th>Category{columns.grip("category", "Category")}</th>
                <th aria-hidden />
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) =>
                editing === r.id ? (
                  <tr key={r.id}>
                    <td colSpan={6}>
                      <RuleEditor
                        budget={budget}
                        initial={r}
                        onCancel={() => setEditing(null)}
                        onSave={(rule) => {
                          edit((d) => {
                            const list = d.payeeRules ?? [];
                            list[list.findIndex((x) => x.id === rule.id)] = rule;
                          });
                          setEditing(null);
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td className="muted">{i + 1}</td>
                    <td>“{r.match}”</td>
                    <td>{r.payee || <span className="muted">Keep the bank's name</span>}</td>
                    <td>{categoryName(r.categoryId)}</td>
                    <td aria-hidden />
                    <td className="row-actions">
                      <button className="icon-button" aria-label={`Edit rule ${i + 1}`} onClick={() => setEditing(r.id)}>
                        <Pencil size={14} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Delete rule ${i + 1}`}
                        onClick={() => {
                          edit((d) => {
                            d.payeeRules = (d.payeeRules ?? []).filter((x) => x.id !== r.id);
                          });
                          toast({ message: `Deleted the rule for “${r.match}”.`, action: undo ? { label: "Undo", onClick: undo } : undefined });
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <section className="panel empty-state compact">
          <h2>No rules yet</h2>
          <p>Add one above to clean up the payee names your bank uses.</p>
        </section>
      )}
    </div>
  );
}
