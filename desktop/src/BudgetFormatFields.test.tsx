import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BudgetFormatFields, type FormatValue } from "./BudgetFormatFields";
import { activeFormat, configureFormat, money } from "./format";

afterEach(() => { cleanup(); configureFormat({ currency: "SAR" }); });

it("previews each currency placement in the selected number format without changing the open budget", () => {
  configureFormat({ currency: "USD" });
  const original = activeFormat();
  const value: FormatValue = {
    currency: "EUR", numberFormat: { decimal: ",", group: ".", symbol: "after" }, dateFormat: "dmy",
  };
  const onChange = vi.fn();
  const { rerender } = render(<BudgetFormatFields value={value} onChange={onChange} />);
  expect(screen.getByRole("option", { name: "Before amount (€1.234,56)" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "After amount (1.234,56 €)" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Don’t show (1.234,56)" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Currency placement"), { target: { value: "none" } });
  expect(onChange).toHaveBeenCalledWith({ ...value, numberFormat: { ...value.numberFormat, symbol: "none" } });

  rerender(<BudgetFormatFields value={{
    ...value, currency: "SAR", numberFormat: { decimal: ".", group: " ", symbol: "before" },
  }} onChange={onChange} />);
  expect(screen.getByRole("option", { name: "Before amount (SAR 1 234.56)" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "After amount (1 234.56 SAR)" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Don’t show (1 234.56)" })).toBeTruthy();
  expect(activeFormat()).toBe(original);
  expect(money(123456)).toBe("$1,234.56");
});
