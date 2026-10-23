import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./bridge", () => ({ desktop: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocked.invoke }));
import { setPref } from "./prefs";
import { useUsageCounts } from "./usage";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  mocked.invoke.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("usage counts", () => {
  it("asks Rust to count this copy after starting and every hour, never right away", () => {
    const { unmount } = renderHook(() => useUsageCounts());
    expect(mocked.invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(mocked.invoke).toHaveBeenCalledWith("report_usage");
    vi.advanceTimersByTime(3600_000);
    expect(mocked.invoke).toHaveBeenCalledTimes(2);
    unmount();
    vi.advanceTimersByTime(3600_000);
    expect(mocked.invoke).toHaveBeenCalledTimes(2);
  });

  it("sends nothing while the Privacy & data switch is off", () => {
    setPref("usageCounts", false);
    renderHook(() => useUsageCounts());
    vi.advanceTimersByTime(2 * 3600_000);
    expect(mocked.invoke).not.toHaveBeenCalled();
    // Turned back on: counted at the next hour.
    setPref("usageCounts", true);
    vi.advanceTimersByTime(3600_000);
    expect(mocked.invoke).toHaveBeenCalledTimes(1);
  });

  it("shrugs off being offline", async () => {
    mocked.invoke.mockRejectedValue(new Error("Couldn't reach urbudget.app."));
    renderHook(() => useUsageCounts());
    vi.advanceTimersByTime(10_000);
    await vi.runOnlyPendingTimersAsync();
    expect(mocked.invoke).toHaveBeenCalled();
  });
});
