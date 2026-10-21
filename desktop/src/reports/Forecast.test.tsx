import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { configureFormat } from "../format";
import { demoBudget } from "../demo";

const read = vi.hoisted(() => vi.fn());
vi.mock("../bridge", () => ({ read, api: {} }));
vi.mock("../charts/Charts", () => ({ Legend: () => null, LinesChart: () => null }));
import { Forecast } from "./Forecast";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

it.each([
  { currency: "USD", decimal: "." as const, group: "," as const, symbol: "before" as const, display: "$1,234.56", edit: "1234.56", updated: "$1,244.56" },
  { currency: "SAR", decimal: "." as const, group: "," as const, symbol: "after" as const, display: "1,234.56 SAR", edit: "1234.56", updated: "1,244.56 SAR" },
  { currency: "EUR", decimal: "," as const, group: "." as const, symbol: "none" as const, display: "1.234,56", edit: "1234,56", updated: "1.244,56" },
])("edits the forecast amount as a number with $currency / $symbol currency display", async ({ currency, decimal, group, symbol, display, edit, updated }) => {
  const budget = { ...demoBudget(), currency, numberFormat: { decimal, group, symbol } };
  configureFormat(budget);
  read.mockResolvedValue({ balances: { checking: 1000000 }, events: [], recentSpending: 123456 });
  render(<Forecast budget={budget} accounts={new Set(["checking"])} inspect={vi.fn()} />);
  const input = await screen.findByLabelText<HTMLInputElement>("Everyday spending a month");
  expect(input.value).toBe(display);

  fireEvent.focus(input);
  expect(input.value).toBe(edit);
  fireEvent.blur(input);
  expect(input.value).toBe(display);

  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: `${input.value} + 10` } });
  fireEvent.blur(input);
  expect(input.value).toBe(updated);
});

it("keeps keyboard commits editable and cancels a later draft without changing the saved forecast", async () => {
  const budget = { ...demoBudget(), currency: "USD" };
  configureFormat(budget);
  read.mockResolvedValue({ balances: { checking: 1000000 }, events: [], recentSpending: 123456 });
  render(<Forecast budget={budget} accounts={new Set(["checking"])} inspect={vi.fn()} />);
  const input = await screen.findByLabelText<HTMLInputElement>("Everyday spending a month");

  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: `${input.value} + 10` } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("1244.56");
  // Enter keeps the field focused: further math must not start with a currency symbol.
  fireEvent.change(input, { target: { value: `${input.value} + 10` } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("1254.56");

  fireEvent.change(input, { target: { value: "9000" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("1254.56");
  fireEvent.blur(input);
  expect(input.value).toBe("$1,254.56");
});
