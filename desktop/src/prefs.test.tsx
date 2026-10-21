import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Budget, Transaction } from "./types";

vi.mock("./bridge", () => ({
  api: {
    upsertTransaction: vi.fn(async (b: Budget, t: Transaction) => ({ ...b, transactions: [...b.transactions, t] })),
    action: vi.fn(async (b: Budget) => b),
    previewSchedules: vi.fn(async (b: Budget) => b),
  },
}));
import { api } from "./bridge";
import { demoBudget } from "./demo";
import { Register } from "./Register";
import { DEFAULT_PREFS, getPref, resetLayout, setPref } from "./prefs";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
const register = () =>
  render(
    <Register
      budget={demoBudget()}
      accountId="checking"
      edit={vi.fn()}
      transform={async (fn) => void (await fn(demoBudget()))}
      onEdit={vi.fn()}
    />,
  );

it("keeps preferences on this computer, with defaults", () => {
  expect(getPref("runningBalance")).toBe(DEFAULT_PREFS.runningBalance);
  setPref("keepBackups", 10);
  expect(getPref("keepBackups")).toBe(10);
  localStorage.setItem("lb:columns:register-v3", "{}");
  localStorage.setItem("lb:budget:collapsed:x", "[]");
  resetLayout();
  expect(localStorage.getItem("lb:columns:register-v3")).toBeNull();
  expect(localStorage.getItem("lb:budget:collapsed:x")).toBeNull();
  expect(getPref("keepBackups")).toBe(10);
});

it("hides the running balance when it's turned off", () => {
  register();
  expect(screen.getByRole("columnheader", { name: "Balance" })).toBeTruthy();
  cleanup();
  setPref("runningBalance", false);
  register();
  expect(screen.queryByRole("columnheader", { name: "Balance" })).toBeNull();
});

it("starts new transactions cleared when asked", async () => {
  setPref("newCleared", true);
  register();
  fireEvent.click(screen.getByRole("button", { name: "Add transaction" }));
  const row = screen.getByRole("row", { name: "New transaction" });
  expect(within(row).getByRole("button", { name: "Cleared" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.change(within(row).getByLabelText("Inflow"), { target: { value: "10" } });
  fireEvent.keyDown(within(row).getByLabelText("Inflow"), { key: "Enter" });
  await waitFor(() => expect(api.upsertTransaction).toHaveBeenCalled());
  expect(api.upsertTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "cleared" }));
});

it("starts one dated ahead uncleared all the same, so it's scheduled", async () => {
  setPref("newCleared", true);
  const transform = vi.fn(async (fn: (b: Budget) => Promise<Budget>) => void (await fn(demoBudget())));
  render(
    <Register budget={demoBudget()} accountId="checking" edit={vi.fn()} transform={transform} onEdit={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add transaction" }));
  const row = screen.getByRole("row", { name: "New transaction" });
  const date = within(row).getByLabelText("Date");
  fireEvent.focus(date);
  fireEvent.change(date, { target: { value: "2999-01-01" } });
  expect(within(row).getByRole("button", { name: "Cleared" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.change(within(row).getByLabelText("Inflow"), { target: { value: "10" } });
  fireEvent.click(within(row).getByRole("button", { name: "Schedule" }));
  await waitFor(() => expect(transform).toHaveBeenCalled());
  expect(api.upsertTransaction).not.toHaveBeenCalled();
});
