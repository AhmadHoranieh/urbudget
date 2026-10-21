import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { Popover } from "./ui";
import { payeeIndex } from "./payees";
import { sameTerm, suggest, termLabel, type Suggestion, type Term } from "./search";
import type { Budget } from "./types";

/**
 * The register's search bar. Filters show as chips; typing offers matching payees, categories,
 * accounts, amounts and states. Enter adds the highlighted one (by default, a text search),
 * Backspace in an empty field removes the last chip.
 */
export function SearchBox({
  budget,
  text,
  terms,
  onText,
  onTerms,
}: {
  budget: Budget;
  text: string;
  terms: Term[];
  onText: (text: string) => void;
  onTerms: (terms: Term[]) => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const payees = useMemo(() => payeeIndex(budget).map((p) => p.name), [budget.transactions, budget.payees]);
  const suggestions = useMemo(
    () => suggest(text, budget, payees).filter((s) => !s.term || !terms.some((t) => sameTerm(t, s.term!))),
    [text, budget.categories, budget.accounts, payees, terms],
  );
  useEffect(() => setActive(0), [text]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const add = (term: Term) => {
    onTerms([...terms, term]);
    onText("");
  };
  const choose = (s: Suggestion | undefined) => {
    if (!s) return;
    if (s.term) add(s.term);
    else if (s.prefix) onText(s.prefix);
    input.current?.focus();
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActive((i) => Math.min(Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)), suggestions.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && suggestions[active]) choose(suggestions[active]);
      else if (text.trim()) add({ field: "text", value: text.trim() });
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      } else if (text) {
        e.preventDefault();
        onText("");
      }
    } else if (e.key === "Backspace" && !text && terms.length) {
      e.preventDefault();
      onTerms(terms.slice(0, -1));
    }
  };
  return (
    <div
      className="search-box"
      ref={box}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          input.current?.focus();
        }
      }}
    >
      <Search size={15} aria-hidden />
      {terms.map((t, i) => (
        <span className={`chip chip-${t.field}`} key={`${i}:${termLabel(t, budget)}`}>
          {termLabel(t, budget)}
          <button
            className="chip-remove"
            aria-label={`Remove ${termLabel(t, budget)}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onTerms(terms.filter((_, j) => j !== i))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        role="combobox"
        aria-label="Search transactions"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && suggestions[active] ? `${id}-${active}` : undefined}
        placeholder={terms.length ? "Add a filter…" : "Search, or type payee: category: amount: is:"}
        value={text}
        onChange={(e) => {
          onText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={keys}
      />
      <Popover
        open={open && suggestions.length > 0}
        onClose={() => setOpen(false)}
        anchor={box}
        matchWidth
        focus={false}
        role="presentation"
        className="search-suggestions"
      >
        <ul id={`${id}-list`} role="listbox" aria-label="Search suggestions" ref={list} onMouseDown={(e) => e.preventDefault()}>
          {!text.trim() && <li className="search-hint">Filter by…</li>}
          {suggestions.map((s, i) => (
            <li
              key={`${i}:${s.label}`}
              id={`${id}-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(s)}
            >
              <span>{s.label}</span>
              {s.hint && <kbd>{s.hint}</kbd>}
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
}
