import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Budget, Transaction } from "./types";

vi.mock("./bridge", () => ({
  api: {
    upsertTransaction: vi.fn(async (b: Budget, t: Transaction) => ({
      ...b, transactions: [...b.transactions.filter((x) => x.id !== t.id), t],
    })),
    previewSchedules: vi.fn(async (b: Budget) => ({
      ...b, schedules: b.schedules!.map((s) => ({ ...s, nextDate: "2020-02-15" })),
    })),
  },
}));
import { api } from "./bridge";
import { demoBudget } from "./demo";
import { saveTransaction } from "./Register";
import { scheduleId } from "./scheduleId";

beforeEach(async () => {
  vi.clearAllMocks();
  // jsdom exposes randomUUID but not SubtleCrypto; use the runtime's actual SHA-256 in tests.
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

const draft = (id: string): Transaction => ({
  ...demoBudget().transactions[0], id, date: "2999-01-15", status: "uncleared",
});
const bytes = (text: string) => new TextEncoder().encode(text).length;

it.each(["a".repeat(65), "a".repeat(100), "é".repeat(50)])(
  "bounds schedule IDs for valid long transaction ID %s and reuses them on retry", async (id) => {
    const t = draft(id);
    const first = await saveTransaction(demoBudget(), t);
    expect(bytes(first.schedules![0].id)).toBeLessThanOrEqual(64);
    expect(first.schedules![0].transaction.id).toBe(id);
    const retry = await saveTransaction(first, { ...t, memo: "Retry with a changed note" });
    expect(retry.schedules).toHaveLength(1);
    expect(retry.schedules![0]).toMatchObject({
      id: first.schedules![0].id,
      transaction: { id, memo: "Retry with a changed note" },
    });
  },
);

it.each(["a".repeat(60), "a".repeat(100)])(
  "moves an occurrence with ID %s without changing its original recurrence", async (id) => {
    const t = { ...draft(id), date: "2020-01-15" };
    const recurring = await saveTransaction(demoBudget(), t, "monthly");
    const original = recurring.schedules![0];
    const moved = { ...t, date: "2999-01-15" };
    const first = await saveTransaction(recurring, moved);
    expect(first.schedules).toHaveLength(2);
    expect(first.schedules![0]).toEqual(original);
    expect(first.schedules![1].frequency).toBe("never");
    expect(first.schedules!.every((s) => bytes(s.id) <= 64)).toBe(true);
    expect(first.transactions.some((entry) => entry.id === id)).toBe(false);
    expect(await saveTransaction(first, moved)).toEqual(first);
  },
);

it("preserves an advanced recurrence when retrying a long-ID draft", async () => {
  const t = { ...draft("a".repeat(100)), date: "2020-01-15" };
  const first = await saveTransaction(demoBudget(), t, "monthly");
  const retry = await saveTransaction(first, t, "monthly");
  expect(bytes(retry.schedules![0].id)).toBeLessThanOrEqual(64);
  expect(retry.schedules).toEqual(first.schedules);
  expect(retry.transactions.filter((entry) => entry.id === t.id)).toHaveLength(1);
  expect(api.previewSchedules).toHaveBeenCalledTimes(1);
});

it.each([
  ["a".repeat(65), "future:awdQEhj_lDM6uJk9a71eziPA7a5EZVn-g4SnZwGW1h0"],
  ["é".repeat(50), "future:bYms6xZpBuJ5kqY4kWL2cOFPOhsXuHRmePyJnZTjakY"],
])("matches the native schedule ID for %s", async (source, expected) => {
  expect(await scheduleId(demoBudget(), source)).toBe(expected);
});

it("avoids both schedule and ledger collisions, keeping its suffix after a collision disappears", async () => {
  const t = draft("a".repeat(65));
  const base = "future:awdQEhj_lDM6uJk9a71eziPA7a5EZVn-g4SnZwGW1h0";
  const occupied = {
    id: base, frequency: "monthly", paused: true, nextDate: "2999-02-15", anchorDate: "2020-02-15",
    transaction: draft("another-schedule"),
  };
  const budget = demoBudget();
  budget.schedules = [occupied];
  budget.transactions.push({ ...draft(`${base}:1`), date: "2020-02-15" });
  const first = await saveTransaction(budget, t);
  expect(first.schedules![0]).toEqual(occupied);
  expect(first.schedules![1].id).toBe(`${base}:2`);
  const withoutCollisions = {
    ...first, schedules: first.schedules!.slice(1),
    transactions: first.transactions.filter((entry) => entry.id !== `${base}:1`),
  };
  const retried = await saveTransaction(withoutCollisions, { ...t, memo: "Retried" });
  expect(retried.schedules).toHaveLength(1);
  expect(retried.schedules![0]).toMatchObject({ id: `${base}:2`, transaction: { memo: "Retried" } });
});

it("preserves an unrelated short-ID schedule and retries the mapped draft after it is deleted", async () => {
  const t = draft("short-draft");
  const budget = demoBudget();
  const occupied = {
    id: t.id, frequency: "monthly", paused: true, nextDate: "2999-02-15", anchorDate: "2020-02-15",
    transaction: draft("unrelated-template"),
  };
  budget.schedules = [occupied];
  const first = await saveTransaction(budget, t);
  expect(first.schedules![0]).toEqual(occupied);
  const mapped = first.schedules![1];
  expect(mapped.id).not.toBe(t.id);
  const retry = await saveTransaction({ ...first, schedules: [mapped] }, t);
  expect(retry.schedules).toEqual([mapped]);
});

it.each([":0", ":01", ":4294967296"])("does not mistake noncanonical suffix %s for a previous draft", async (suffix) => {
  const t = draft("a".repeat(65));
  const base = "future:awdQEhj_lDM6uJk9a71eziPA7a5EZVn-g4SnZwGW1h0";
  const budget = demoBudget();
  budget.schedules = [{
    id: `${base}${suffix}`, transaction: t, frequency: "monthly", paused: true,
    nextDate: "2999-02-15", anchorDate: "2020-02-15",
  }];
  expect(await scheduleId(budget, t.id)).toBe(base);
});
