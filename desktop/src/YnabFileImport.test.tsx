import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Budget } from "./types";

const imported = {
  name: "Household",
  currency: "USD",
  schemaVersion: 2,
  accounts: [
    { id: "a1", name: "Checking", kind: "cash", openingBalance: 0, archived: false },
    { id: "a2", name: "Brokerage", kind: "tracking", openingBalance: 0, archived: false },
  ],
  categories: [{ id: "c1", name: "Food", group: "Living", target: 0 }],
  transactions: [],
  assignments: [{ month: "2026-10", categoryId: "c1", amount: 5000 }],
  importAudit: {
    categoryMonthChecks: 12,
    accountChecks: 0,
    monthChecks: 0,
    accountDifferences: [],
    readyToAssignDifferences: [],
    categoryDifferences: [{ month: "2026-10", category: "Food", field: "balance", expected: 1000, actual: 900 }],
  },
} as unknown as Budget;

vi.mock("./bridge", () => ({
  api: {
    importYnabFiles: vi.fn(async () => imported),
    createBudget: vi.fn(async () => "new-id"),
  },
}));
import { api } from "./bridge";
import { YnabFileImport } from "./YnabFileImport";
import { demoBudget } from "./demo";
import { configureFormat } from "./format";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  configureFormat(demoBudget());
});

it("previews YNAB's export, then saves it as a new budget and opens it", async () => {
  const openBudget = vi.fn(async () => {});
  const current = demoBudget();
  render(<YnabFileImport budget={current} openBudget={openBudget} />);
  const zip = new File([new Uint8Array([80, 75, 3, 4])], "YNAB Export - Household.zip");
  fireEvent.change(screen.getByLabelText("YNAB export file"), { target: { files: [zip] } });

  await screen.findByText("Household");
  expect(api.importYnabFiles).toHaveBeenCalledWith(
    [{ name: "YNAB Export - Household.zip", bytes: [80, 75, 3, 4] }],
    null,
    current.currency,
  );
  expect(screen.getByText(/1 amounts differ/)).toBeTruthy();
  expect(screen.getByText(/Food, 2026-10: available/)).toBeTruthy();
  expect(screen.getByText(/Tracking accounts: Brokerage/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Create “Household” and open it" }));
  await waitFor(() => expect(openBudget).toHaveBeenCalledWith("new-id"));
  expect(vi.mocked(api.createBudget).mock.calls[0][0]).toMatchObject({ name: "Household", currency: "USD" });
  expect(screen.getByText(/Created “Household”/)).toBeTruthy();
});

it.each([
  { symbol: "after" as const, expected: "available $9,00 here, $10,00 in YNAB", saved: "before" },
  { symbol: "none" as const, expected: "available 9,00 here, 10,00 in YNAB", saved: "none" },
])("uses the imported currency and preserves $symbol visibility in preview and saved budget", async ({ symbol, expected, saved }) => {
  const current = {
    ...demoBudget(),
    currency: "EUR",
    numberFormat: { decimal: "," as const, group: "." as const, symbol },
  };
  configureFormat(current);
  render(<YnabFileImport budget={current} openBudget={vi.fn(async () => {})} />);
  fireEvent.change(screen.getByLabelText("YNAB export file"), {
    target: { files: [new File(["Account"], "Register.csv")] },
  });
  const difference = await screen.findByText(/Food, 2026-10: available/);
  expect(difference.textContent).toContain(expected);
  expect(difference.textContent).not.toContain("€");
  fireEvent.click(screen.getByRole("button", { name: "Create “Household” and open it" }));
  await waitFor(() => expect(api.createBudget).toHaveBeenCalledWith(expect.objectContaining({
    currency: "USD",
    numberFormat: { decimal: ",", group: ".", symbol: saved },
  })));
});

it("reads the files again in the date order chosen", async () => {
  render(<YnabFileImport budget={demoBudget()} openBudget={vi.fn()} />);
  const register = new File(["Account"], "Register.csv");
  fireEvent.change(screen.getByLabelText("YNAB export file"), { target: { files: [register] } });
  await screen.findByText("Household");
  fireEvent.change(screen.getByLabelText("Date order in the file"), { target: { value: "dmy" } });
  await waitFor(() => expect(api.importYnabFiles).toHaveBeenLastCalledWith(expect.any(Array), "dmy", "SAR"));
});

it("retries opening an already created import without creating another budget", async () => {
  const openBudget = vi.fn(async () => {}).mockRejectedValueOnce(new Error("Could not open the budget"));
  render(<YnabFileImport budget={demoBudget()} openBudget={openBudget} />);
  fireEvent.change(screen.getByLabelText("YNAB export file"), {
    target: { files: [new File(["Account"], "Register.csv")] },
  });
  const create = await screen.findByRole("button", { name: "Create “Household” and open it" });
  fireEvent.click(create);
  await screen.findByText("Could not open the budget");
  fireEvent.click(create);
  await screen.findByText(/Created “Household”/);
  expect(api.createBudget).toHaveBeenCalledOnce();
  expect(openBudget.mock.calls).toEqual([["new-id"], ["new-id"]]);
});

it("creates a new budget for a different export after an earlier open failed", async () => {
  vi.mocked(api.createBudget).mockResolvedValueOnce("first-id").mockResolvedValueOnce("second-id");
  const openBudget = vi.fn(async () => {}).mockRejectedValueOnce(new Error("Could not open the budget"));
  render(<YnabFileImport budget={demoBudget()} openBudget={openBudget} />);
  const picker = screen.getByLabelText("YNAB export file");
  fireEvent.change(picker, { target: { files: [new File(["Account"], "First.csv")] } });
  fireEvent.click(await screen.findByRole("button", { name: "Create “Household” and open it" }));
  await screen.findByText("Could not open the budget");

  vi.mocked(api.importYnabFiles).mockResolvedValueOnce({ ...imported, name: "Another plan" });
  fireEvent.change(picker, { target: { files: [new File(["Account"], "Second.csv")] } });
  fireEvent.click(await screen.findByRole("button", { name: "Create “Another plan” and open it" }));
  await screen.findByText(/Created “Another plan”/);
  expect(api.createBudget).toHaveBeenCalledTimes(2);
  expect(api.createBudget).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Another plan" }));
  expect(openBudget.mock.calls).toEqual([["first-id"], ["second-id"]]);
});

it("passes the import to the welcome flow without creating or opening another budget", async () => {
  const openBudget = vi.fn(async () => {});
  const onBudget = vi.fn(async () => {});
  const current = demoBudget();
  render(<YnabFileImport budget={current} openBudget={openBudget} onBudget={onBudget} />);
  fireEvent.change(screen.getByLabelText("YNAB export file"), {
    target: { files: [new File(["Account"], "Register.csv")] },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Import “Household”" }));
  await waitFor(() => expect(onBudget).toHaveBeenCalledWith(expect.objectContaining({
    name: "Household", currency: "USD", dateFormat: current.dateFormat,
  })));
  expect(api.createBudget).not.toHaveBeenCalled();
  expect(openBudget).not.toHaveBeenCalled();
});

function sizedFile(name: string, size: number) {
  const file = new File(["Account"], name);
  Object.defineProperty(file, "size", { value: size });
  const read = vi.spyOn(file, "arrayBuffer");
  return { file, read };
}

it("rejects an oversized file before reading or allocating its IPC payload", async () => {
  render(<YnabFileImport budget={demoBudget()} openBudget={vi.fn()} />);
  const { file, read } = sizedFile("Large Register.csv", 8 * 1024 * 1024 + 1);
  fireEvent.change(screen.getByLabelText("YNAB export file"), { target: { files: [file] } });
  expect(await screen.findByText(/Large Register.csv is larger than 8 MB/)).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
  expect(api.importYnabFiles).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Choose other files…" }).hasAttribute("disabled")).toBe(false);
});

it("checks the whole selection before reading any individually valid file", async () => {
  render(<YnabFileImport budget={demoBudget()} openBudget={vi.fn()} />);
  const files = Array.from({ length: 3 }, (_, i) => sizedFile(`Part${i}.csv`, 6 * 1024 * 1024));
  fireEvent.change(screen.getByLabelText("YNAB export file"), { target: { files: files.map((f) => f.file) } });
  expect(await screen.findByText(/total more than 16 MB/)).toBeTruthy();
  files.forEach(({ read }) => expect(read).not.toHaveBeenCalled());
  expect(api.importYnabFiles).not.toHaveBeenCalled();
});

it("rejects too many files before reading them and accepts a corrected selection", async () => {
  render(<YnabFileImport budget={demoBudget()} openBudget={vi.fn()} />);
  const files = Array.from({ length: 9 }, (_, i) => sizedFile(`Part${i}.csv`, 100));
  const picker = screen.getByLabelText("YNAB export file");
  fireEvent.change(picker, { target: { files: files.map((f) => f.file) } });
  expect(await screen.findByText("Choose at most 8 export files at once.")).toBeTruthy();
  files.forEach(({ read }) => expect(read).not.toHaveBeenCalled());
  const boundary = sizedFile("Register.csv", 8 * 1024 * 1024);
  fireEvent.change(picker, { target: { files: [boundary.file] } });
  await screen.findByText("Household");
  expect(boundary.read).toHaveBeenCalledOnce();
  expect(api.importYnabFiles).toHaveBeenCalledOnce();
});
