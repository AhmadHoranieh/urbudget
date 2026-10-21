import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSteady } from "./useSteady";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const busy = (v: string) => v !== "";

it("hides a passing state that ends quickly", () => {
  const { result, rerender } = renderHook(({ v }) => useSteady(v, busy), { initialProps: { v: "" } });
  rerender({ v: "Saving changes…" });
  expect(result.current).toBe("");
  act(() => vi.advanceTimersByTime(100));
  rerender({ v: "" });
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current).toBe("");
});

it("shows a passing state once it has lasted, and follows it from then on", () => {
  const { result, rerender } = renderHook(({ v }) => useSteady(v, busy), { initialProps: { v: "" } });
  rerender({ v: "Downloading your YNAB plan…" });
  act(() => vi.advanceTimersByTime(400));
  expect(result.current).toBe("Downloading your YNAB plan…");
  rerender({ v: "Validating balances…" });
  expect(result.current).toBe("Validating balances…");
  rerender({ v: "" });
  expect(result.current).toBe("");
});

it("keeps the last steady value during a quick passing state", () => {
  const passing = (s: string) => s === "saving" || s === "pending";
  const { result, rerender } = renderHook(({ v }) => useSteady(v, passing), { initialProps: { v: "saved" } });
  rerender({ v: "pending" });
  rerender({ v: "saving" });
  expect(result.current).toBe("saved");
  rerender({ v: "saved" });
  expect(result.current).toBe("saved");
  rerender({ v: "error" });
  expect(result.current).toBe("error");
});
