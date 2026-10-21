import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AmountInput } from "./CategoryRow";
import { configureFormat, money, type NumberFormat } from "./format";
import { demoBudget } from "./demo";
import { TransactionsPage } from "./Register";
import { ColumnChart, LinesChart } from "./charts/Charts";
import { ToastProvider } from "./ui";

vi.mock("./bridge", () => ({ api: {} }));

afterEach(() => {
  cleanup();
  configureFormat({ currency: "SAR" });
  localStorage.clear();
});

it.each([
  { currency: "USD", symbol: "before", decimal: ".", group: ",", shown: "-$1,234.56", edit: "-1234.56", expression: "1000+234.56" },
  { currency: "EUR", symbol: "after", decimal: ",", group: ".", shown: "-1.234,56 €", edit: "-1234,56", expression: "1000+234,56" },
  { currency: "SAR", symbol: "after", decimal: ".", group: ",", shown: "-1,234.56 SAR", edit: "-1234.56", expression: "1000+234.56" },
  { currency: "USD", symbol: "none", decimal: ".", group: ",", shown: "-1,234.56", edit: "-1234.56", expression: "1000+234.56" },
])("keeps $currency / $symbol amount editing numeric and preserves arithmetic", (format) => {
  configureFormat({ currency: format.currency, numberFormat: format as NumberFormat });
  const save = vi.fn();
  render(<AmountInput amount={-123456} onSave={save} label="Assigned" />);
  const input = screen.getByLabelText("Assigned") as HTMLInputElement;
  expect(input.value).toBe(format.shown);
  fireEvent.focus(input);
  expect(input.value).toBe(format.edit);
  fireEvent.blur(input);
  expect(save).not.toHaveBeenCalled();
  expect(input.getAttribute("aria-invalid")).toBe("false");
  expect(input.value).toBe(format.shown);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: format.expression } });
  fireEvent.blur(input);
  expect(save).toHaveBeenCalledWith(123456);
});

it("updates an unfocused amount when currency placement changes", () => {
  configureFormat({ currency: "USD" });
  const field = <AmountInput amount={123456} onSave={() => {}} label="Assigned" />;
  const view = render(field);
  expect((screen.getByLabelText("Assigned") as HTMLInputElement).value).toBe("$1,234.56");
  configureFormat({ currency: "USD", numberFormat: { symbol: "none" } });
  view.rerender(<AmountInput amount={123456} onSave={() => {}} label="Assigned" />);
  expect((screen.getByLabelText("Assigned") as HTMLInputElement).value).toBe("1,234.56");
});

it("applies placement once to register totals and rows, and retains numeric search", () => {
  const budget = demoBudget();
  budget.currency = "USD";
  budget.transactions = [{ ...budget.transactions[0], payee: "Currency example", amount: -123456, splits: [] }];
  const page = () => <ToastProvider><TransactionsPage
    budget={budget} accountId="all" netWorth={123456}
    edit={() => {}} transform={async () => {}} onEdit={() => {}} onAddDialog={() => {}}
    onEditAccount={() => {}} onReconcile={() => {}} onImport={() => {}} onSync={() => {}}
  /></ToastProvider>;
  configureFormat(budget);
  const view = render(page());
  expect(view.container.querySelector(".register-summary strong")?.textContent).toBe("$1,234.56");
  expect(view.container.querySelector('[data-field="Outflow"]')?.textContent).toBe("$1,234.56");
  fireEvent.change(screen.getByLabelText("Search transactions"), { target: { value: "1,234.56" } });
  expect(screen.getByText("Currency example")).toBeTruthy();
  configureFormat({ ...budget, numberFormat: { symbol: "none" } });
  view.rerender(page());
  expect(view.container.querySelector(".register-summary strong")?.textContent).toBe("1,234.56");
  expect(view.container.querySelector('[data-field="Outflow"]')?.textContent).toBe("1,234.56");
  configureFormat({ ...budget, numberFormat: { decimal: ",", group: ".", symbol: "after" } });
  view.rerender(page());
  fireEvent.change(screen.getByLabelText("Search transactions"), { target: { value: "1.234,56" } });
  expect(screen.getByText("Currency example")).toBeTruthy();
  expect(view.container.querySelector('[data-field="Outflow"]')?.textContent).toBe("1.234,56 $");
});

it("identifies compact money axes, respects hidden currency, and leaves non-money axes alone", () => {
  configureFormat({ currency: "SAR" });
  const chart = () => <ColumnChart months={["2026-10"]} label="Spending" format={money}
    series={[{ key: "a", label: "Food", color: "red", values: [123456] }]} />;
  const view = render(chart());
  expect(view.container.querySelector(".chart-axes")?.textContent).toContain("SAR");
  fireEvent.focus(view.container.querySelector(".chart-hit")!);
  expect(screen.getByRole("status").textContent).toContain("1,234.56 SAR");
  configureFormat({ currency: "SAR", numberFormat: { symbol: "none" } });
  view.rerender(chart());
  expect(view.container.querySelector(".chart-axes")?.textContent).not.toContain("SAR");
  expect(screen.getByRole("status").textContent).toContain("1,234.56");
  configureFormat({ currency: "SAR" });
  view.rerender(<LinesChart keys={["2026-10"]} label="Age of money" format={(v) => `${v} days`} axisFormat={String}
    series={[{ key: "days", label: "Age", color: "red", values: [30] }]} />);
  expect(view.container.querySelector(".chart-axes")?.textContent).not.toContain("SAR");
});
