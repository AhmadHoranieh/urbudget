import { useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronLeft, Search } from "lucide-react";
import {
  BarList,
  ColumnChart,
  DivergingList,
  Donut,
  HeatCalendar,
  Legend,
  Treemap,
  type Series,
} from "../charts/Charts";
import { formatDate, money, monthName } from "../format";
import { Tabs, useFirstWeekday, useVirtualRows } from "../ui";
import { today } from "../types";
import {
  OTHER,
  Panel,
  ReportTable,
  SERIES,
  Tiles,
  fmt,
  lastDay,
  firstDay,
  share,
  sum,
  useReportColumns,
  type Scope,
} from "./shared";

/** Totals by group, or by category within one group. */
function totalsBy(categories: Record<string, number>, scope: Scope, group: string | null) {
  const out = new Map<string, number>();
  for (const [id, v] of Object.entries(categories)) {
    const g = scope.groupOf.get(id);
    if (!g) continue;
    const key = group === null ? g : g === group ? id : null;
    if (key !== null) out.set(key, (out.get(key) ?? 0) + v);
  }
  return out;
}

export function ByCategory({ scope }: { scope: Scope }) {
  const { data, budget, nameOf, spendingGroups, colorOf } = scope;
  const [group, setGroup] = useState<string | null>(null);
  const n = Math.max(1, data.months.length);
  // Colours follow the entity: groups by budget order; categories by their order in the group.
  const order = group ? [...new Set([
    ...budget.categories.filter((c) => c.group === group && !c.paymentAccountId).map((c) => c.id),
    // Report-only buckets have names/groups, but never become budget envelopes.
    ...Object.keys(data.categories).filter((id) => scope.groupOf.get(id) === group),
  ])] : [];
  const catColor = (id: string) => {
    const i = order.indexOf(id);
    return i >= 0 && i < 7 ? SERIES(i) : OTHER;
  };
  const totals = totalsBy(data.categories, scope, group);
  const rows = (group ? [...totals.keys()] : spendingGroups)
    .map((key) => ({
      key,
      label: group ? (nameOf.get(key) ?? key) : key,
      value: totals.get(key) ?? 0,
      color: group ? catColor(key) : colorOf(key),
    }))
    .filter((r) => r.value !== 0)
    .sort((a, b) => b.value - a.value);
  const total = sum(rows.map((r) => r.value));
  const other = rows.filter((r) => r.color === OTHER && r.value > 0);
  const slices = [
    ...rows.filter((r) => r.color !== OTHER && r.value > 0),
    ...(other.length ? [{ key: "__other", label: "Other", value: sum(other.map((r) => r.value)), color: OTHER }] : []),
  ];
  const top = rows[0];
  const open = (key: string) => {
    if (key === "__other") return;
    if (group) scope.show({ title: nameOf.get(key) ?? key, categoryId: key });
    else setGroup(key);
  };
  return (
    <>
      <Tiles
        items={[
          {
            label: group ? `Spent in ${group}` : "Spending",
            value: fmt(total),
            note: group
              ? `${share(total, data.spending)} of all spending`
              : `over ${n} ${n === 1 ? "month" : "months"}`,
          },
          { label: "Monthly average", value: fmt(Math.round(total / n)) },
          {
            label: group ? "Biggest category" : "Biggest group",
            value: top?.label ?? "—",
            note: top ? `${fmt(top.value)} · ${share(top.value, total)}` : undefined,
          },
          {
            label: group ? "Categories with spending" : "Groups with spending",
            value: rows.filter((r) => r.value > 0).length,
          },
        ]}
      />
      <Panel
        title={
          group ? (
            <>
              <button className="link-button" onClick={() => setGroup(null)}>
                <ChevronLeft size={15} /> All groups
              </button>
              <span className="muted">/</span> {group}
            </>
          ) : (
            "Spending by group"
          )
        }
      >
        {rows.length ? (
          <div className="donut-layout">
            <Donut
              slices={slices}
              label={group ? `Spending in ${group} by category` : "Spending by group"}
              format={fmt}
              center={{ value: money(total), label: group ?? "Spent" }}
              onSelect={open}
            />
            <BarList
              rows={rows.map((r) => ({
                ...r,
                detail: share(r.value, total),
                onSelect: () => open(r.key),
                hint: group ? "List these transactions" : `Show categories in ${r.key}`,
              }))}
              color={SERIES(0)}
              format={fmt}
              label={group ? `Spending in ${group}` : "Spending by group"}
            />
          </div>
        ) : (
          <p className="empty-state compact">No spending in these months.</p>
        )}
        <p className="help">
          {group ? "Select a category to see its transactions." : "Select a group to see its categories."} Refunds
          reduce spending, so a category can be negative. The ring shows only groups or categories with net spending;
          the total and list include refunds.
        </p>
      </Panel>
      {data.months.length >= 2 && <Changes scope={scope} group={group} />}
    </>
  );
}

/** The last month of the range against the average of the months before it. */
function Changes({ scope, group }: { scope: Scope; group: string | null }) {
  const all = scope.data.months;
  const months = all[all.length - 1].month === today().slice(0, 7) && all.length > 2 ? all.slice(0, -1) : all;
  const last = months[months.length - 1];
  const earlier = months.slice(0, -1);
  const now = totalsBy(last.categories, scope, group);
  const average = new Map<string, number>();
  for (const m of earlier)
    for (const [k, v] of totalsBy(m.categories, scope, group))
      average.set(k, (average.get(k) ?? 0) + v / earlier.length);
  const rows = [...new Set([...now.keys(), ...average.keys()])]
    .map((key) => ({
      key,
      label: group ? (scope.nameOf.get(key) ?? key) : key,
      value: Math.round((now.get(key) ?? 0) - (average.get(key) ?? 0)),
      detail: `avg ${money(Math.round(average.get(key) ?? 0))}`,
    }))
    .filter((r) => r.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 10);
  const partial = last.month === today().slice(0, 7);
  return (
    <Panel
      title={`${monthName(last.month)}${partial ? " so far" : ""} against your average`}
      aside={<span className="muted">the {earlier.length}-month average before it</span>}
    >
      {rows.length ? (
        <>
          <DivergingList
            rows={rows}
            format={money}
            label={`Change in spending in ${monthName(last.month)}`}
            colors={{ more: "var(--diverging-negative)", less: "var(--diverging-positive)" }}
          />
          <Legend
            items={[
              { label: "Spent less than average", color: "var(--diverging-positive)" },
              { label: "Spent more than average", color: "var(--diverging-negative)" },
            ]}
          />
        </>
      ) : (
        <p className="empty-state compact">Spending matched the average.</p>
      )}
    </Panel>
  );
}

/**
 * The payees big enough to read as tiles (at least 1.5% of the set, 8 to 14 of them) and the
 * rest, which share one "others" tile. A single leftover payee keeps its own tile.
 */
export function foldPayees<T extends { amount: number }>(list: T[]) {
  const total = sum(list.map((p) => p.amount));
  let n = 0;
  while (n < list.length && n < 14 && (n < 8 || list[n].amount / total >= 0.015)) n++;
  return list.length - n <= 1 ? { shown: list, rest: [] as T[] } : { shown: list.slice(0, n), rest: list.slice(n) };
}

type PayeeSpending = { name: string; amount: number; count: number };
// The collapsed-border table's measured row height, matching .payee-table in reports.css.
const PAYEE_ROW = 36;

function PayeeTable({ payees, total, onOpen }: { payees: PayeeSpending[]; total: number; onOpen: (name: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const rows = useVirtualRows(box, payees.length, PAYEE_ROW);
  const table = useReportColumns("payees", 4, 220);
  return (
    <div className="report-table scrolls payee-table" ref={box} tabIndex={0} role="region" aria-label="Payee spending rows">
      <table className="fixed" style={table.style} aria-label="Payee spending" aria-rowcount={payees.length + 1}>
        {table.cols}
        <thead>
          <tr aria-rowindex={1}>
            <th>Payee{table.grip("label", "Payee")}</th>
            <th className="num">Spent{table.grip("value", "amount")}</th>
            <th className="num">Share{table.grip("value", "amount")}</th>
            <th className="num">Transactions{table.grip("value", "amount")}</th>
            <th className="num">Average{table.grip("value", "amount")}</th>
            <th aria-hidden />
          </tr>
        </thead>
        <tbody>
          {rows.before > 0 && <tr aria-hidden className="spacer-row" style={{ height: rows.before }}><td colSpan={6} /></tr>}
          {payees.slice(rows.start, rows.end).map((p, i) => (
            <tr key={p.name} aria-rowindex={rows.start + i + 2}>
              <td>
                <button className="link-button cell-link" onClick={() => onOpen(p.name)} title="Show these transactions">
                  {p.name || "No payee"}
                </button>
              </td>
              <td className="num">{money(p.amount)}</td>
              <td className="num">{share(p.amount, total)}</td>
              <td className="num">{p.count}</td>
              <td className="num">{money(Math.round(p.amount / Math.max(1, p.count)))}</td>
              <td aria-hidden />
            </tr>
          ))}
          {rows.after > 0 && <tr aria-hidden className="spacer-row" style={{ height: rows.after }}><td colSpan={6} /></tr>}
          {!payees.length && <tr><td colSpan={6} className="muted">No payees match.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function ByPayee({ scope }: { scope: Scope }) {
  const { data } = scope;
  const [query, setQuery] = useState("");
  const allPayees = useRef<HTMLDivElement>(null);
  const all = useMemo(
    () =>
      Object.entries(data.payees ?? {})
        .map(([name, p]) => ({ name, ...p }))
        .sort((a, b) => b.amount - a.amount),
    [data.payees],
  );
  const total = sum(all.map((p) => p.amount));
  const count = data.transactionCount ?? sum(all.map((p) => p.count));
  const positive = useMemo(() => all.filter((p) => p.amount > 0), [all]);
  const positiveTotal = sum(positive.map((p) => p.amount));
  const refunds = -sum(all.filter((p) => p.amount < 0).map((p) => p.amount));
  const top = positive[0];
  // The map shows the payees big enough to read; everyone is in the table below it.
  const { shown: big, rest } = useMemo(() => foldPayees(positive), [positive]);
  const restTotal = sum(rest.map((p) => p.amount));
  const tiles = big.map((p) => ({
    key: p.name,
    label: p.name || "No payee",
    value: p.amount,
    detail: `${share(p.amount, positiveTotal)} of spending shown`,
    more: `${p.count} ${p.count === 1 ? "transaction" : "transactions"} · avg ${money(Math.round(p.amount / Math.max(1, p.count)))}`,
  }));
  const shown = useMemo(() => {
    const search = query.trim().toLowerCase();
    return search ? all.filter((p) => p.name.toLowerCase().includes(search)) : all;
  }, [all, query]);
  const open = (name: string) => scope.show({ title: name || "No payee", payee: name });
  return (
    <>
      <Tiles
        items={[
          { label: "Spending", value: fmt(total), note: `at ${all.length} ${all.length === 1 ? "payee" : "payees"}` },
          {
            label: "Top payee",
            value: top ? top.name || "No payee" : "—",
            note: top ? `${fmt(top.amount)} · ${share(top.amount, positiveTotal)} of spending shown` : undefined,
          },
          {
            label: "Average per transaction",
            value: count ? fmt(Math.round(total / count)) : "—",
            note: `${count} transactions`,
          },
          {
            label: "Top 5 payees",
            value: share(sum(positive.slice(0, 5).map((p) => p.amount)), positiveTotal),
            note: "of spending shown",
          },
        ]}
      />
      <Panel
        title={rest.length ? `Top ${big.length} payees` : "Where your money goes"}
        aside={
          <span className="muted">
            {rest.length ? `${share(positiveTotal - restTotal, positiveTotal)} of spending shown · ` : ""}Bigger tiles, more spent
          </span>
        }
      >
        {positive.length ? (
          <Treemap items={tiles} format={fmt} label="Spending by payee" onSelect={open} height={320} />
        ) : (
          <p className="empty-state compact">No payees with net spending in these months.</p>
        )}
        <div className="treemap-foot">
          <p className="help">
            Select a payee to see its transactions. Tiles show payees with net spending; the total and table include refunds.
            {refunds > 0 && ` Net refunds of ${fmt(refunds)} at other payees reduce the total.`}
          </p>
          {rest.length > 0 && (
            <button
              className="link-button"
              onClick={() => allPayees.current?.scrollIntoView?.({ behavior: "smooth", block: "start" })}
            >
              {rest.length} more {rest.length === 1 ? "payee" : "payees"} · {fmt(restTotal)} <ArrowDown size={13} />
            </button>
          )}
        </div>
      </Panel>
      <div ref={allPayees} className="scroll-anchor">
        <Panel
          title="All payees"
          aside={
            <label className="report-search">
              <Search size={14} aria-hidden />
              <input
                aria-label="Find a payee"
                placeholder="Find a payee"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          }
        >
          {/* A new search starts at its first match instead of retaining the previous scroll. */}
          <PayeeTable key={query} payees={shown} total={total} onOpen={open} />
        </Panel>
      </div>
    </>
  );
}

export function OverTime({ scope }: { scope: Scope }) {
  const { data, groupOf, spendingGroups, colorOf } = scope;
  const [mode, setMode] = useState<"groups" | "total">("groups");
  const months = data.months.map((m) => m.month);
  const series: Series[] = [];
  for (const g of spendingGroups) {
    const color = colorOf(g);
    const label = color === OTHER ? "Other" : g;
    const values = data.months.map((m) =>
      sum(
        Object.entries(m.categories)
          .filter(([id]) => groupOf.get(id) === g)
          .map(([, n]) => n),
      ),
    );
    const existing = series.find((s) => s.label === label);
    if (existing) existing.values = existing.values.map((v, i) => v + values[i]);
    else series.push({ key: g, label, color, values });
  }
  const shown = series.filter((s) => s.values.some((v) => v !== 0));
  const totals = data.months.map((m) => m.spending);
  const average = totals.length ? Math.round(sum(totals) / totals.length) : 0;
  const byAmount = [...data.months].sort((a, b) => b.spending - a.spending);
  const half = Math.floor(totals.length / 2);
  const recent = half ? sum(totals.slice(-half)) / half : 0,
    before = half ? sum(totals.slice(0, half)) / half : 0;
  const table = useReportColumns("trends", (mode === "groups" ? shown.length : 0) + 1);
  return (
    <>
      <Tiles
        items={[
          { label: "Monthly average", value: fmt(average) },
          {
            label: "Highest month",
            value: byAmount[0] ? fmt(byAmount[0].spending) : "—",
            note: byAmount[0] && monthName(byAmount[0].month),
          },
          {
            label: "Lowest month",
            value: byAmount.length ? fmt(byAmount[byAmount.length - 1].spending) : "—",
            note: byAmount.length ? monthName(byAmount[byAmount.length - 1].month) : undefined,
          },
          {
            label: "Trend",
            value:
              half && before
                ? `${recent >= before ? "+" : ""}${(((recent - before) / before) * 100).toFixed(0)}%`
                : "—",
            note: half ? `last ${half} months against the ${half} before` : "needs two months or more",
            tone: half && before ? (recent > before ? "negative" : "positive") : undefined,
          },
        ]}
      />
      <Panel
        title="Spending by month"
        aside={
          <Tabs<"groups" | "total">
            label="Show"
            value={mode}
            onChange={setMode}
            tabs={[
              { id: "groups", label: "By group" },
              { id: "total", label: "Total" },
            ]}
          />
        }
      >
        <ColumnChart
          months={months}
          series={mode === "total" ? [{ key: "total", label: "Spending", color: SERIES(0), values: totals }] : shown}
          average={{ label: "Average", value: average }}
          label={`Spending by month${mode === "groups" ? ", stacked by category group" : ""}`}
          format={fmt}
        />
        {mode === "groups" && <Legend items={shown.map((s) => ({ label: s.label, color: s.color }))} />}
        <ReportTable>
          <table className="fixed" style={table.style}>
            {table.cols}
            <thead>
              <tr>
                <th>Month{table.grip("label", "Month")}</th>
                {mode === "groups" &&
                  shown.map((s) => (
                    <th key={s.key} className="num">
                      {s.label}
                      {table.grip("value", "amount")}
                    </th>
                  ))}
                <th className="num">Total{table.grip("value", "amount")}</th>
                <th aria-hidden />
              </tr>
            </thead>
            <tbody>
              {data.months.map((m, i) => (
                <tr key={m.month}>
                  <td>{monthName(m.month, "short")}</td>
                  {mode === "groups" &&
                    shown.map((s) => (
                      <td key={s.key} className="num">
                        {money(s.values[i])}
                      </td>
                    ))}
                  <td className="num">
                    <strong>{money(m.spending)}</strong>
                  </td>
                  <td aria-hidden />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Average</th>
                {mode === "groups" &&
                  shown.map((s) => (
                    <th key={s.key} className="num">
                      {money(Math.round(sum(s.values) / Math.max(1, months.length)))}
                    </th>
                  ))}
                <th className="num">{money(average)}</th>
                <th aria-hidden />
              </tr>
            </tfoot>
          </table>
        </ReportTable>
      </Panel>
    </>
  );
}

const weekdayName = (d: number, style: "short" | "long" = "long") =>
  new Date(2026, 1, 1 + d, 12).toLocaleDateString("en-GB", { weekday: style });

export function SpendingCalendar({ scope }: { scope: Scope }) {
  const { data } = scope;
  const weekStart = useFirstWeekday();
  const from = firstDay(scope.from);
  const end = lastDay(scope.to);
  const to = end > today() ? today() : end;
  const values = data.days ?? {};
  const days: string[] = [];
  for (let d = new Date(`${from}T12:00:00`); days.length < 3700; d.setDate(d.getDate() + 1)) {
    const iso = d.toLocaleDateString("en-CA");
    if (iso > to) break;
    days.push(iso);
  }
  const spent = days.filter((d) => (values[d] ?? 0) > 0);
  const busiest = [...spent].sort((a, b) => values[b] - values[a]);
  const weekdays = Array.from({ length: 7 }, (_, i) => (i + weekStart) % 7);
  const byWeekday = weekdays.map((w) => {
    const these = days.filter((d) => new Date(`${d}T12:00:00`).getDay() === w);
    return these.length ? Math.round(sum(these.map((d) => values[d] ?? 0)) / these.length) : 0;
  });
  const topWeekday = byWeekday.indexOf(Math.max(...byWeekday));
  const table = useReportColumns("busiest-days", 2, 150);
  return (
    <>
      <Tiles
        items={[
          {
            label: "Average a day",
            value: days.length ? fmt(Math.round(sum(days.map((d) => values[d] ?? 0)) / days.length)) : "—",
          },
          {
            label: "No-spend days",
            value: days.length - spent.length,
            note: `of ${days.length} days · ${share(days.length - spent.length, days.length)}`,
          },
          {
            label: "Biggest day",
            value: busiest[0] ? fmt(values[busiest[0]]) : "—",
            note: busiest[0] && formatDate(busiest[0]),
          },
          {
            label: "Busiest weekday",
            value: spent.length ? weekdayName(weekdays[topWeekday]) : "—",
            note: spent.length ? `${fmt(byWeekday[topWeekday])} on average` : undefined,
          },
        ]}
      />
      <Panel title="Spending by day">
        {days.length ? (
          <HeatCalendar
            from={from}
            to={to}
            values={values}
            format={fmt}
            formatDay={(d) => `${weekdayName(new Date(`${d}T12:00:00`).getDay())} ${formatDate(d)}`}
            weekStart={weekStart}
            label="Spending on each day, darker for more"
            onSelect={(d) => scope.show({ title: `${weekdayName(new Date(`${d}T12:00:00`).getDay())} ${formatDate(d)}`, from: d, to: d })}
          />
        ) : (
          <p className="empty-state compact">These months haven't started yet.</p>
        )}
      </Panel>
      <div className="report-pair">
        <Panel title="By day of the week" aside={<span className="muted">Average spent</span>}>
          <ColumnChart
            months={weekdays.map(String)}
            series={[{ key: "avg", label: "Average", color: SERIES(0), values: byWeekday }]}
            label="Average spending on each day of the week"
            format={fmt}
            tick={(k) => weekdayName(Number(k), "short")}
            title={(k) => weekdayName(Number(k))}
            height={200}
          />
        </Panel>
        <Panel title="Biggest days">
          <ReportTable>
            <table className="fixed" style={table.style}>
              {table.cols}
              <thead>
                <tr>
                  <th>Date{table.grip("label", "Date")}</th>
                  <th>Day{table.grip("value", "Day")}</th>
                  <th className="num">Spent{table.grip("value", "amount")}</th>
                  <th aria-hidden />
                </tr>
              </thead>
              <tbody>
                {busiest.slice(0, 10).map((d) => (
                  <tr key={d}>
                    <td>
                      <button
                        className="link-button cell-link"
                        onClick={() => scope.show({ title: `${weekdayName(new Date(`${d}T12:00:00`).getDay())} ${formatDate(d)}`, from: d, to: d })}
                        title="Show this day's transactions"
                      >
                        {formatDate(d)}
                      </button>
                    </td>
                    <td>{weekdayName(new Date(`${d}T12:00:00`).getDay(), "short")}</td>
                    <td className="num">{money(values[d])}</td>
                    <td aria-hidden />
                  </tr>
                ))}
                {!busiest.length && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No spending in these months.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ReportTable>
        </Panel>
      </div>
    </>
  );
}
