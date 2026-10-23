import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Budget, Transaction } from "./types";

vi.mock("./bridge", () => ({
  api: {
    previewBank: vi.fn(async () => [
      { id: "r1", date: "2026-10-03", payee: "Grocery store", memo: "", amount: -8540, duplicate: false, candidates: [] },
    ]),
    importBank: vi.fn(async (b: Budget) => b),
    decodeStatement: vi.fn(async (latin1: string) => ({ text: latin1, encoding: "ISO-8859-1" })),
    bankFileColumns: vi.fn(async () => ({
      headers: ["Date", "Payee", "Amount"],
      samples: [["2026-10-03", "Grocery store", "-85.40"]],
      format: "csv",
      columns: { date: "Date", payee: "Payee", amount: "Amount" },
      saved: false,
      dateFormat: "ymd",
      flipSigns: false,
    })),
    writeExport: vi.fn(async () => "C:/budget/exports/bank-import-template.csv"),
    reveal: vi.fn(async () => {}),
  },
}));
import { api } from "./bridge";
import { BankImport, ImportReview, bankTemplate, categorizeText, importHelpText, statementText, uncategorizedImports } from "./BankImport";
import { demoBudget } from "./demo";
import { ToastProvider } from "./ui";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

it("lets an identical ID-less receipt be imported separately with a stable retry identity", () => {
  const onImport = vi.fn();
  const row = { id: "bank:known", date: "2026-10-03", payee: "Shop", memo: "Second receipt", amount: -500, duplicate: true, idless: true, candidates: ["manual"] };
  render(<ImportReview budget={demoBudget()} rows={[row]} busy={false} icon={null} title="File" onCancel={() => {}} onImport={onImport} />);
  const action = screen.getByLabelText("Import action 1");
  expect(screen.queryByRole("option", { name: /^Match:/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Import 0 transactions" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(action, { target: { value: "separate" } });
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  expect(onImport).toHaveBeenCalledTimes(2);
  const first = onImport.mock.calls[0][0][0];
  expect(first.action).toBe("new");
  expect(first.row.id).toBe(row.id);
  expect(first.row.importId).toMatch(/^bank:manual:/);
  expect(onImport.mock.calls[1][0][0].row.importId).toBe(first.row.importId);
  expect(screen.getByText("Second receipt")).toBeTruthy();
});

it("skips a chosen row when a refreshed preview confirms it was imported", () => {
  const row = { id: "bank:pending", date: "2026-10-03", payee: "Shop", memo: "", amount: -500, duplicate: false, idless: true, candidates: [] };
  const props = { budget: demoBudget(), busy: false, icon: null, title: "File", onCancel: () => {}, onImport: vi.fn() };
  const view = render(<ImportReview {...props} rows={[row]} />);
  fireEvent.change(screen.getByLabelText("Import action 1"), { target: { value: "new" } });
  view.rerender(<ImportReview {...props} rows={[{ ...row, duplicate: true }]} />);
  expect((screen.getByLabelText("Import action 1") as HTMLSelectElement).value).toBe("skip");
  expect(screen.getByRole("button", { name: "Import 0 transactions" }).hasAttribute("disabled")).toBe(true);
});

it("requires another choice when a refreshed preview removes a selected match", () => {
  const row = { id: "bank:pending", date: "2026-10-03", payee: "Shop", memo: "", amount: -500, duplicate: false, candidates: ["original", "other"] };
  const props = { budget: demoBudget(), busy: false, icon: null, title: "Bank", onCancel: () => {}, onImport: vi.fn() };
  const view = render(<ImportReview {...props} rows={[row]} />);
  fireEvent.change(screen.getByLabelText("Import action 1"), { target: { value: "match:original" } });
  view.rerender(<ImportReview {...props} rows={[{ ...row, candidates: [] }]} />);
  expect((screen.getByLabelText("Import action 1") as HTMLSelectElement).value).toBe("review");
  const importButton = screen.getByRole("button", { name: "Import 1 transaction" });
  expect(importButton.hasAttribute("disabled")).toBe(true);
  fireEvent.click(importButton);
  expect(props.onImport).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Import action 1"), { target: { value: "new" } });
  fireEvent.click(importButton);
  expect(props.onImport.mock.calls[0][0][0]).toMatchObject({ action: "new", matchId: null });
});

it("keeps bank-provided IDs deduplicated and requires a choice for legacy ambiguous imports", () => {
  const onImport = vi.fn();
  const row = { id: "bank:legacy-new-identity", date: "2026-10-03", payee: "Shop", memo: "Receipt", amount: -500, duplicate: false, idless: true, possibleDuplicate: true, candidates: ["manual"] };
  render(<ImportReview budget={demoBudget()} rows={[row, { ...row, id: "bank:fit", idless: false, duplicate: true, possibleDuplicate: false }]} busy={false} icon={null} title="File" onCancel={() => {}} onImport={onImport} />);
  expect((screen.getByLabelText("Import action 1") as HTMLSelectElement).value).toBe("review");
  expect(screen.queryByLabelText("Import action 2")).toBeNull();
  expect(screen.getByRole("button", { name: "Import 1 transaction" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Import action 1"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  expect(onImport.mock.calls[0][0].map((c: { action: string }) => c.action)).toEqual(["new", "skip"]);
});

it.each([false, true])("requires an explicit match for a previously imported account side (split: %s)", (split) => {
  const b = demoBudget();
  const t = { ...b.transactions[0], id: "payment", payee: "Shop", memo: "Receipt", splits: [{ amount: -500, categoryId: null }] };
  const id = split ? "receiving-leg" : t.id;
  const row = { id: "bank:other-source", date: "2026-10-03", payee: "Shop", memo: "", amount: split ? 500 : -500, duplicate: false, candidates: [id], previouslyMatchedCandidates: [id],
    candidateDetails: split ? [{ id, transactionId: t.id, splitIndex: 0 }] : [] };
  const onImport = vi.fn();
  render(<ImportReview budget={{ ...b, transactions: [t] }} rows={[row]} busy={false} icon={null} title="Bank" onCancel={() => {}} onImport={onImport} />);
  const action = screen.getByLabelText("Import action 1") as HTMLSelectElement;
  expect(action.value).toBe("review");
  expect(screen.getByRole("option", { name: /Match:.*Previously imported/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Import 1 transaction" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(action, { target: { value: `match:${id}` } });
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  expect(onImport).toHaveBeenCalledWith([{ row, action: "match", matchId: id }], 1);
});

it("lets a distinct receipt be added instead of automatically merging into an imported payment", () => {
  const row = { id: "bank:receipt-b", date: "2026-10-03", payee: "Shop", memo: "Receipt B", amount: -500, duplicate: false, idless: true, candidates: ["payment"], previouslyMatchedCandidates: ["payment"] };
  const onImport = vi.fn();
  render(<ImportReview budget={demoBudget()} rows={[row]} busy={false} icon={null} title="File" onCancel={() => {}} onImport={onImport} />);
  expect((screen.getByLabelText("Import action 1") as HTMLSelectElement).value).toBe("review");
  fireEvent.change(screen.getByLabelText("Import action 1"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  expect(onImport).toHaveBeenCalledWith([{ row, action: "new", matchId: null }], 1);
});

it("still defaults to matching one account side that has not been imported", () => {
  const row = { id: "bank:new", date: "2026-10-03", payee: "Shop", memo: "", amount: -500, duplicate: false, candidates: ["payment"] };
  const onImport = vi.fn();
  render(<ImportReview budget={demoBudget()} rows={[row]} busy={false} icon={null} title="File" onCancel={() => {}} onImport={onImport} />);
  expect((screen.getByLabelText("Import action 1") as HTMLSelectElement).value).toBe("match:payment");
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  expect(onImport).toHaveBeenCalledWith([{ row, action: "match", matchId: "payment" }], 1);
});

it("labels and submits receiving split legs independently", () => {
  const b = demoBudget();
  const t = { ...b.transactions[0], id: "parent", payee: "Transfer", splits: [{ amount: -500, categoryId: null, memo: "First leg" }, { amount: -500, categoryId: null, memo: "Second leg" }] };
  const row = { id: "bank:one", date: "2026-10-03", payee: "Transfer", memo: "", amount: 500, duplicate: false, candidates: ["leg-a", "leg-b"], candidateDetails: [{ id: "leg-a", transactionId: "parent", splitIndex: 0 }, { id: "leg-b", transactionId: "parent", splitIndex: 1 }] };
  const onImport = vi.fn();
  render(<ImportReview budget={{ ...b, transactions: [t] }} rows={[row, { ...row, id: "bank:two" }]} busy={false} icon={null} title="Bank" onCancel={() => {}} onImport={onImport} />);
  expect(screen.getAllByRole("option", { name: /Split 1 · First leg/ })).toHaveLength(2);
  expect(screen.getAllByRole("option", { name: /Split 2 · Second leg/ })).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Import action 1"), { target: { value: "match:leg-a" } });
  fireEvent.change(screen.getByLabelText("Import action 2"), { target: { value: "match:leg-b" } });
  fireEvent.click(screen.getByRole("button", { name: "Import 2 transactions" }));
  expect(onImport.mock.calls[0][0].map((c: { matchId: string }) => c.matchId)).toEqual(["leg-a", "leg-b"]);
});

it("makes a template in the chosen date order", () => {
  expect(bankTemplate("dmy", "2026-10").split("\r\n")).toEqual([
    "Date,Payee,Memo,Outflow,Inflow",
    "01/10/2026,Employer,Salary,,5000.00",
    "03/10/2026,Grocery store,Weekly shop,85.40,",
    "05/10/2026,Electric company,Monthly bill,120.00,",
    "",
  ]);
  expect(bankTemplate("ymd", "2026-10")).toContain("2026-10-03,Grocery store");
  expect(bankTemplate("mdy", "2026-10")).toContain("10/05/2026,Electric company");
});

it("previews a chosen file and imports it into the dialog's account", async () => {
  const b = demoBudget();
  const onImported = vi.fn();
  render(
    <ToastProvider>
      <BankImport
        budget={b}
        transform={async (work) => void (await work(b))}
        initialAccount="checking"
        embedded
        onImported={onImported}
      />
    </ToastProvider>,
  );
  // The dialog for one account doesn't ask which account.
  expect(screen.queryByLabelText("Into account")).toBeNull();
  const file = new File(["Date,Payee,Amount\n2026-10-03,Grocery store,-85.40\n"], "october.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [file] } });
  expect(screen.getByText("october.csv")).toBeTruthy();
  expect(screen.getByLabelText("Dates in the file")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Preview transactions" }));
  expect(await screen.findByText("Grocery store")).toBeTruthy();
  expect(api.previewBank).toHaveBeenCalledWith(
    b,
    "checking",
    expect.stringContaining("Grocery store"),
    "csv",
    "ymd",
    false,
    null,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  await waitFor(() => expect(onImported).toHaveBeenCalledWith(1, { ids: [], accounts: [] }));
  // The account keeps the date order and signs, and the columns only when they were chosen.
  expect(api.importBank).toHaveBeenCalledWith(b, "checking", expect.any(Array), { dateFormat: "ymd", flipSigns: false });
});

it("lets the columns be chosen when their names aren't known, and the account keeps them", async () => {
  const unknown = { format: "csv", headers: ["Wann", "Wer", "Wieviel"], samples: [["15.10.2026", "Bäckerei", "-3,20"]], columns: {}, saved: false, flipSigns: false };
  vi.mocked(api.bankFileColumns)
    .mockResolvedValueOnce({ ...unknown, dateFormat: null })
    .mockResolvedValueOnce({ ...unknown, columns: { date: "Wann" }, dateFormat: "dmy" });
  const b = demoBudget();
  render(
    <ToastProvider>
      <BankImport budget={b} transform={async (work) => void (await work(b))} initialAccount="checking" embedded onImported={vi.fn()} />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByLabelText("Bank file"), {
    target: { files: [new File(["Wann;Wer;Wieviel\n15.10.2026;Bäckerei;-3,20\n"], "konto.csv")] },
  });
  expect(await screen.findByText(/Choose the column with each transaction's date/)).toBeTruthy();
  const dates = screen.getByLabelText("Dates in the file") as HTMLSelectElement;
  expect(dates.value).toBe("ymd");
  const preview = screen.getByRole("button", { name: "Preview transactions" });
  expect(preview.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Date column"), { target: { value: "Wann" } });
  // The dates in the column chosen say they're day first.
  await waitFor(() => expect(dates.value).toBe("dmy"));
  expect(api.bankFileColumns).toHaveBeenLastCalledWith(b, "checking", expect.any(String), { date: "Wann" });
  fireEvent.change(screen.getByLabelText("Payee column"), { target: { value: "Wer" } });
  fireEvent.change(screen.getByLabelText("Amount column"), { target: { value: "Wieviel" } });
  // What the first row has there, to tell the columns apart.
  expect(screen.getByText("15.10.2026")).toBeTruthy();
  expect(screen.getByText("-3,20")).toBeTruthy();
  const columns = { date: "Wann", payee: "Wer", amount: "Wieviel" };
  fireEvent.click(preview);
  expect(await screen.findByText("Grocery store")).toBeTruthy();
  expect(api.previewBank).toHaveBeenCalledWith(b, "checking", expect.any(String), "csv", "dmy", false, columns);
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  await waitFor(() =>
    expect(api.importBank).toHaveBeenCalledWith(b, "checking", expect.any(Array), { dateFormat: "dmy", flipSigns: false, columns }),
  );
});

it("says which columns it reads, and when they're the ones chosen for the account", async () => {
  vi.mocked(api.bankFileColumns).mockResolvedValueOnce({
    format: "csv",
    headers: ["Type", "Started Date", "Description", "Amount", "Fee"],
    samples: [],
    columns: { date: "Started Date", payee: "Description", amount: "Amount" },
    saved: true,
    dateFormat: "ymd",
    flipSigns: true,
  });
  const b = demoBudget();
  render(
    <ToastProvider>
      <BankImport budget={b} transform={async () => {}} initialAccount="checking" embedded />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [new File(["x"], "revolut.csv")] } });
  const summary = await screen.findByText(/Columns you chose for this account/);
  expect(summary.textContent).toBe("Columns you chose for this account: Date from Started Date · Payee from Description · Amount from Amount");
  // The signs the account kept, too.
  expect((screen.getByLabelText("Purchases are positive") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Preview transactions" }));
  expect(await screen.findByText("Grocery store")).toBeTruthy();
  expect(api.previewBank).toHaveBeenCalledWith(b, "checking", "x", "csv", "ymd", true, null);
  cleanup();
  render(
    <ToastProvider>
      <BankImport budget={b} transform={async () => {}} initialAccount="checking" embedded />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [new File(["x"], "october.csv")] } });
  fireEvent.click(await screen.findByRole("button", { name: "Change columns" }));
  expect((screen.getByLabelText("Date column") as HTMLSelectElement).value).toBe("Date");
});

it("offers the other side of money moved from another account as a transfer", () => {
  const b = demoBudget();
  const move: Transaction = { ...imported("move", "savings", null, -20000), payee: "TO EVERYDAY", date: "2026-10-02" };
  const row = { id: "bank:in", date: "2026-10-03", payee: "From savings", memo: "", amount: 20000, duplicate: false, candidates: ["move"], transferCandidates: ["move"], transferSure: true };
  const onImport = vi.fn();
  render(<ImportReview budget={{ ...b, transactions: [move] }} rows={[row]} busy={false} icon={null} title="File" onCancel={() => {}} onImport={onImport} />);
  expect((screen.getByLabelText("Import action 1") as HTMLSelectElement).value).toBe("match:move");
  expect(screen.getByRole("option", { name: /^Transfer from Savings: .* · TO EVERYDAY$/ })).toBeTruthy();
  expect(screen.getByText(/1 transfer between your accounts/)).toBeTruthy();
  expect(screen.getByText(/isn't counted as spending or income/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  expect(onImport).toHaveBeenCalledWith([{ row, action: "match", matchId: "move" }], 1);
});

it("only suggests a transfer the bank text doesn't back up, and pairs the suggestions in one go", () => {
  const b = demoBudget();
  const move = (id: string): Transaction => ({ ...imported(id, "savings", null, -20000), payee: "A. Example", date: "2026-10-02" });
  const row = (id: string, other: string) => ({ id, date: "2026-10-03", payee: "Incoming", memo: "", amount: 20000, duplicate: false, candidates: [other], transferCandidates: [other] });
  const rows = [row("bank:a", "m1"), row("bank:b", "m2"), { ...row("bank:c", "m3"), transferSure: true }];
  const onImport = vi.fn();
  render(<ImportReview budget={{ ...b, transactions: [move("m1"), move("m2"), move("m3")] }} rows={rows} busy={false} icon={null} title="File" onCancel={() => {}} onImport={onImport} />);
  const first = screen.getByLabelText("Import action 1") as HTMLSelectElement;
  expect([first.value, first.selectedOptions[0].textContent]).toEqual(["review", "Transfer suggested — check it and choose"]);
  expect((screen.getByLabelText("Import action 3") as HTMLSelectElement).value).toBe("match:m3");
  expect(screen.getByText("2 rows need a choice")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pair 2 suggested transfers" }));
  expect(screen.queryByRole("button", { name: /suggested transfer|as new/ })).toBeNull();
  expect(screen.getByText(/3 transfers between your accounts/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Import 3 transactions" }));
  expect(onImport.mock.calls[0][0].map((c: { matchId: string }) => c.matchId)).toEqual(["m1", "m2", "m3"]);
});

it("decides every row still undecided at once", () => {
  const row = (id: string) => ({ id, date: "2026-10-03", payee: "Fee", memo: "", amount: -100, duplicate: false, candidates: ["a", "b"] });
  const onImport = vi.fn();
  render(<ImportReview budget={demoBudget()} rows={[row("one"), row("two"), { ...row("three"), candidates: [] }]} busy={false} icon={null} title="File" onCancel={() => {}} onImport={onImport} />);
  expect(screen.getByText("2 rows need a choice")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Skip them" }));
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  expect(onImport.mock.calls[0][0].map((c: { action: string }) => c.action)).toEqual(["skip", "skip", "new"]);
});

it("lists the nearest fifty of thousands of possible matches", () => {
  const b = demoBudget();
  // 120 earlier charges of the same amount, one a day back from the row's date.
  const fees: Transaction[] = Array.from({ length: 120 }, (_, i) => ({
    ...imported(`fee${i}`, "checking", "groceries", -100),
    date: new Date(Date.UTC(2026, 9, 20 - i)).toISOString().slice(0, 10),
  }));
  const ids = fees.map((t) => t.id);
  const row = { id: "bank:fee", date: "2026-10-20", payee: "Fee", memo: "", amount: -100, duplicate: false, candidates: [...ids].reverse(), previouslyMatchedCandidates: ids };
  render(<ImportReview budget={{ ...b, transactions: fees }} rows={[row]} busy={false} icon={null} title="File" onCancel={() => {}} onImport={() => {}} />);
  const matches = screen.getAllByRole("option").filter((o) => (o as HTMLOptionElement).value.startsWith("match:"));
  expect(matches.map((o) => (o as HTMLOptionElement).value)).toEqual(ids.slice(0, 50).map((id) => `match:${id}`));
  expect(screen.getByRole("option", { name: "70 more of the same amount within ten days aren't listed" })).toBeTruthy();
});

it("reads statements in the encodings banks write", async () => {
  const bytes = (...values: number[]) => new Blob([new Uint8Array(values)]);
  // Not UTF-8 (Windows-1250, as Polish banks export): the engine tells which encoding, given a
  // character for each byte.
  vi.mocked(api.decodeStatement).mockResolvedValueOnce({ text: "Tytuł;ŻABKA", encoding: "windows-1250" });
  expect(await statementText(bytes(0x54, 0x79, 0x74, 0x75, 0xb3, 0x3b, 0xaf, 0x41, 0x42, 0x4b, 0x41))).toBe("Tytuł;ŻABKA");
  expect(api.decodeStatement).toHaveBeenCalledWith("Tytu\u00b3;\u00afABKA");
  // An Excel workbook (a ZIP inside) goes to the engine too, which gives back its sheet as CSV.
  vi.mocked(api.decodeStatement).mockResolvedValueOnce({ text: "Date,Payee,Amount", encoding: "spreadsheet" });
  expect(await statementText(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00))).toBe("Date,Payee,Amount");
  // UTF-8, with and without a byte-order mark.
  expect(await statementText(bytes(0xef, 0xbb, 0xbf, 0x42, 0xc3, 0xa4))).toBe("Bä");
  expect(await statementText(bytes(0x42, 0xc3, 0xa4))).toBe("Bä");
  // UTF-16, as Excel saves "Unicode text", with a mark or without one.
  expect(await statementText(bytes(0xff, 0xfe, 0x44, 0x00, 0xe4, 0x00))).toBe("Dä");
  expect(await statementText(bytes(0xfe, 0xff, 0x00, 0x44, 0x00, 0xe4))).toBe("Dä");
  expect(await statementText(bytes(0x44, 0x00, 0x61, 0x00, 0x74, 0x00, 0x65, 0x00))).toBe("Date");
  expect(api.decodeStatement).toHaveBeenCalledTimes(2);
});

it("sends a PDF statement to the assistant, and reads an Excel one as a table", async () => {
  const b = demoBudget();
  const onAskAssistant = vi.fn();
  render(
    <ToastProvider>
      <BankImport budget={b} transform={async () => {}} initialAccount="checking" embedded onAskAssistant={onAskAssistant} />
    </ToastProvider>,
  );
  const pdf = new File(["%PDF-1.7"], "Kontoauszug_2026_10.pdf");
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [pdf] } });
  expect(screen.getByText(/PDF statements need the assistant/)).toBeTruthy();
  expect(screen.queryByLabelText("Read as")).toBeNull();
  expect((screen.getByRole("button", { name: "Preview transactions" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Read it with the assistant" }));
  expect(onAskAssistant).toHaveBeenCalledWith(pdf, "", "Everyday account");
  expect(screen.getByText(/^PDF · /)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [new File(["PK"], "Movimientos.xlsx")] } });
  expect((screen.getByLabelText("Read as") as HTMLSelectElement).value).toBe("csv");
  expect(screen.getByRole("option", { name: "CSV or Excel" })).toBeTruthy();
  cleanup();
  // Where no one can open the assistant, it says so and what to download instead.
  render(
    <ToastProvider>
      <BankImport budget={b} transform={async () => {}} initialAccount="checking" embedded />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [pdf] } });
  expect(screen.getByText(/PDF statements need the assistant, which isn't available here/)).toBeTruthy();
});

it("reads a bank's own statement formats, whatever the file is called", async () => {
  const b = demoBudget();
  render(
    <ToastProvider>
      <BankImport budget={b} transform={async () => {}} initialAccount="checking" embedded />
    </ToastProvider>,
  );
  // ISO 20022 statements are .xml files, and need no date order or columns.
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [new File(["<Document/>"], "camt053_2026-10.xml")] } });
  expect((screen.getByLabelText("Read as") as HTMLSelectElement).value).toBe("camt053");
  expect(screen.queryByLabelText("Dates in the file")).toBeNull();
  expect(api.bankFileColumns).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [new File([":20:STARTUMS"], "konto.sta")] } });
  expect((screen.getByLabelText("Read as") as HTMLSelectElement).value).toBe("mt940");
  // An MT940 statement saved as .txt: the engine finds no columns, and says what it is.
  vi.mocked(api.bankFileColumns).mockResolvedValueOnce({ format: "mt940", headers: [], samples: [], columns: {}, saved: false, dateFormat: null, flipSigns: false });
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [new File([":20:STARTUMS"], "umsaetze.txt")] } });
  await waitFor(() => expect((screen.getByLabelText("Read as") as HTMLSelectElement).value).toBe("mt940"));
  fireEvent.click(screen.getByRole("button", { name: "Preview transactions" }));
  expect(await screen.findByText("Grocery store")).toBeTruthy();
  expect(api.previewBank).toHaveBeenCalledWith(b, "checking", ":20:STARTUMS", "mt940", "ymd", false, null);
});

it("reads a card's positive purchases as money out when asked", async () => {
  const b = demoBudget();
  render(
    <ToastProvider>
      <BankImport budget={b} transform={async () => {}} initialAccount="checking" embedded />
    </ToastProvider>,
  );
  const choose = (name: string) =>
    fireEvent.change(screen.getByLabelText("Bank file"), {
      target: { files: [new File(["Date,Description,Amount\n2026-10-03,Grocery store,85.40\n"], name)] },
    });
  // Only a CSV can need it: OFX and QFX amounts are always signed the standard way.
  choose("october.qfx");
  expect(screen.queryByLabelText("Purchases are positive")).toBeNull();
  choose("october.csv");
  fireEvent.click(screen.getByLabelText("Purchases are positive"));
  fireEvent.click(screen.getByRole("button", { name: "Preview transactions" }));
  expect(await screen.findByText("Grocery store")).toBeTruthy();
  expect(api.previewBank).toHaveBeenCalledWith(b, "checking", expect.any(String), "csv", "ymd", true, null);
});

it("saves a template and offers to show it", async () => {
  render(
    <ToastProvider>
      <BankImport budget={demoBudget()} transform={async () => {}} />
    </ToastProvider>,
  );
  expect(screen.getByLabelText("Into account")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Download a template/ }));
  await waitFor(() =>
    expect(api.writeExport).toHaveBeenCalledWith(
      "bank-import-template.csv",
      expect.stringContaining("Date,Payee,Memo,Outflow,Inflow"),
    ),
  );
  expect(await screen.findByText("Template saved.")).toBeTruthy();
});

it("words the request to the assistant, with the problem when there is one", () => {
  expect(importHelpText("Everyday")).toBe(
    "Help me import this file into Everyday. Find the transactions, ask me about anything unclear, and prepare them for the import review.",
  );
  expect(importHelpText("Card", "The file has no transactions to import.")).toContain(
    "into Card. The import preview said: The file has no transactions to import. Find",
  );
});

function renderWithAssistant(onAskAssistant?: (file: File, problem: string) => void) {
  const b = demoBudget();
  render(
    <ToastProvider>
      <BankImport budget={b} transform={async () => {}} initialAccount="checking" embedded onAskAssistant={onAskAssistant} />
    </ToastProvider>,
  );
  const file = new File(["Account statement\nDate,Payee,Amount\n"], "statement.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("Bank file"), { target: { files: [file] } });
  return file;
}

it("offers the assistant once a file is chosen, and hands it the file", () => {
  const ask = vi.fn();
  const file = renderWithAssistant(ask);
  const help = screen.getByRole("button", { name: "Help with this import" });
  // Before any problem it's a quiet offer, for someone who isn't sure where to start.
  expect(help.className).toContain("secondary");
  expect(screen.getByText(/Nothing is sent until you press Send/)).toBeTruthy();
  fireEvent.click(help);
  expect(ask).toHaveBeenCalledWith(file, "", "Everyday account");
});

it("offers the assistant first when the preview fails, with the reason", async () => {
  vi.mocked(api.previewBank).mockRejectedValueOnce(new Error("CSV needs Date, Payee/Description, and Amount headers."));
  const ask = vi.fn();
  const file = renderWithAssistant(ask);
  fireEvent.click(screen.getByRole("button", { name: "Preview transactions" }));
  expect(await screen.findByText(/can read this file, find the transactions/)).toBeTruthy();
  const help = screen.getByRole("button", { name: "Help with this import" });
  expect(help.className).toContain("primary");
  fireEvent.click(help);
  expect(ask).toHaveBeenCalledWith(file, "CSV needs Date, Payee/Description, and Amount headers.", "Everyday account");
});

it("offers the assistant when a file has no transactions the importer can find", async () => {
  vi.mocked(api.previewBank).mockResolvedValueOnce([]);
  const ask = vi.fn();
  renderWithAssistant(ask);
  fireEvent.click(screen.getByRole("button", { name: "Preview transactions" }));
  expect(await screen.findByText("The file has no transactions to import.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Help with this import" }));
  expect(ask).toHaveBeenCalledWith(expect.any(File), "The file has no transactions to import.", "Everyday account");
});

it("points out a file where every row came out as money in", async () => {
  const row = (id: string, amount: number) => ({ id, date: "2026-10-03", payee: `Shop ${id}`, memo: "", amount, duplicate: false, candidates: [] });
  vi.mocked(api.previewBank).mockResolvedValueOnce([row("a", 1200), row("b", 3450), row("c", 999)]);
  const ask = vi.fn();
  renderWithAssistant(ask);
  fireEvent.click(screen.getByRole("button", { name: "Preview transactions" }));
  expect(await screen.findByText(/the signs are probably reversed/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Help with this import" }));
  expect(ask).toHaveBeenCalledWith(expect.any(File), "Every row came out as money in.", "Everyday account");
});

it("shows the name a payee rule gives a row, beside the bank's", async () => {
  const row = { date: "2026-10-03", memo: "", amount: -650, duplicate: false, candidates: [] };
  vi.mocked(api.previewBank).mockResolvedValueOnce([
    { ...row, id: "a", payee: "SQ *BLUE BOTTLE 0042", rename: "Blue Bottle", categoryId: "x" },
    { ...row, id: "b", payee: "ELSEWHERE" },
  ]);
  renderWithAssistant();
  fireEvent.click(screen.getByRole("button", { name: "Preview transactions" }));
  expect(await screen.findByText(/1 renamed by your payee rules/)).toBeTruthy();
  const cell = screen.getByTitle("Blue Bottle, from the bank's “SQ *BLUE BOTTLE 0042”");
  expect(cell.textContent).toBe("Blue BottleSQ *BLUE BOTTLE 0042");
  expect(screen.getByText("ELSEWHERE")).toBeTruthy();
});

it("keeps quiet about the assistant where no one can open it", () => {
  renderWithAssistant(undefined);
  expect(screen.queryByRole("button", { name: "Help with this import" })).toBeNull();
});

const imported = (id: string, accountId: string, categoryId: string | null, amount = -1000): Transaction => ({
  id,
  date: "2026-10-16",
  accountId,
  payee: "Shop",
  memo: "",
  amount,
  status: "cleared",
  splits: [{ categoryId, amount }],
  transferAccountId: null,
  transferStatus: null,
  approved: false,
});
/** The demo budget after an import added these transactions, with the Uncategorized placeholder it creates. */
const after = (b: Budget, ...added: Transaction[]): Budget => ({
  ...b,
  categories: [...b.categories, { id: "local-uncategorized", name: "Uncategorized", group: "Needs review", target: 0 }],
  transactions: [...b.transactions, ...added],
});

it("finds the new transactions an import left without a category", () => {
  const b = { ...demoBudget(), accounts: [...demoBudget().accounts, { id: "car", name: "Car", kind: "tracking" as const, openingBalance: 0, archived: false }] };
  const next = after(
    b,
    imported("bank:a", "checking", "local-uncategorized"),
    imported("bank:b", "checking", null, 250000),
    // A payee rule categorized this one.
    imported("bank:c", "checking", "groceries"),
    imported("bank:d", "credit", "local-uncategorized"),
    // Tracking accounts don't use categories.
    imported("bank:e", "car", null),
  );
  expect(uncategorizedImports(b, next)).toEqual({ ids: ["bank:a", "bank:b", "bank:d"], accounts: ["Everyday account", "Credit card"] });
  // Transactions that were already there (a match) don't count, even without a category.
  expect(uncategorizedImports(next, next)).toEqual({ ids: [], accounts: [] });
});

it("words the request with the count and the accounts", () => {
  expect(categorizeText({ ids: ["a"], accounts: ["Checking"] })).toBe("Categorize the new transaction in Checking.");
  expect(categorizeText({ ids: Array.from({ length: 12 }, (_, i) => `t${i}`), accounts: ["Checking"] })).toBe(
    "Categorize the 12 new transactions in Checking.",
  );
  expect(categorizeText({ ids: ["a", "b"], accounts: ["Checking", "Savings"] })).toBe(
    "Categorize the 2 new transactions in Checking and Savings.",
  );
  expect(categorizeText({ ids: ["a", "b", "c"], accounts: ["A", "B", "C"] })).toBe("Categorize the 3 new transactions in A, B and C.");
  expect(categorizeText({ ids: Array.from({ length: 230 }, (_, i) => `t${i}`), accounts: ["Checking"] })).toBe(
    "Categorize these 200 of the 230 new transactions in Checking.",
  );
});

async function importOne(props: Partial<Parameters<typeof BankImport>[0]>, added: Transaction[]) {
  const b = demoBudget();
  vi.mocked(api.importBank).mockImplementation(async (budget: Budget) => after(budget, ...added));
  render(
    <ToastProvider>
      <BankImport budget={b} transform={async (work) => void (await work(b))} initialAccount="checking" {...props} />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByLabelText("Bank file"), {
    target: { files: [new File(["Date,Payee,Amount\n2026-10-03,Grocery store,-85.40\n"], "october.csv")] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview transactions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Import 1 transaction" }));
}

it("hands the import dialog the new transactions without a category", async () => {
  const onImported = vi.fn();
  await importOne({ embedded: true, onImported }, [imported("bank:a", "checking", "local-uncategorized")]);
  await waitFor(() => expect(onImported).toHaveBeenCalledWith(1, { ids: ["bank:a"], accounts: ["Everyday account"] }));
});

it("offers the assistant after an import only when something came in without a category", async () => {
  const onCategorize = vi.fn();
  await importOne({ onCategorize }, [imported("bank:a", "checking", "local-uncategorized"), imported("bank:b", "checking", null, 5000)]);
  expect(await screen.findByText("2 new transactions have no category.")).toBeTruthy();
  expect(screen.getByText(/Nothing is sent until you press Send/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Categorize with the assistant" }));
  expect(onCategorize).toHaveBeenCalledWith({ ids: ["bank:a", "bank:b"], accounts: ["Everyday account"] });
  expect(screen.queryByRole("button", { name: "Categorize with the assistant" })).toBeNull();
  cleanup();
  // Payee rules categorized everything: no offer.
  await importOne({ onCategorize: vi.fn() }, [imported("bank:c", "checking", "groceries")]);
  expect(await screen.findByText(/Imported 1 transaction/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Categorize with the assistant" })).toBeNull();
});
