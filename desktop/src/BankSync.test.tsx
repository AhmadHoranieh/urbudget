import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { produce } from "immer";
import type { Budget } from "./types";
import type { AccountReview, SimpleFinStatus, Synced } from "./simplefin";

vi.mock("./simplefin", () => ({
  simplefin: {
    status: vi.fn(),
    connect: vi.fn(),
    refresh: vi.fn(),
    disconnect: vi.fn(),
    openBridge: vi.fn(async () => {}),
    sync: vi.fn(),
    import: vi.fn(),
  },
}));
import { simplefin } from "./simplefin";
import { BankSync, BankSyncDetails, BankSyncSettings, daysAgo, linkAccount, listedAccounts, staleSync, syncHelpText } from "./BankSync";
import { demoBudget } from "./demo";
import { configureFormat } from "./format";
import { ToastProvider } from "./ui";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  configureFormat({ currency: "USD" });
});

const usd = (): Budget => ({ ...demoBudget(), currency: "USD" });
const checking = { id: "ACT-1", name: "Everyday Checking", org: "First Bank", currency: "USD", balance: 152015, balanceDate: "2026-10-18" };
const euro = { id: "ACT-2", name: "Euro Savings", org: "First Bank", currency: "EUR", balance: 100, balanceDate: null };
const status = (over: Partial<SimpleFinStatus> = {}): SimpleFinStatus => ({
  store: "Credential Manager",
  connected: true,
  accounts: [checking, euro],
  messages: [],
  requestsToday: 2,
  dailyLimit: 20,
  ...over,
});

it("counts days back on the calendar", () => {
  expect(daysAgo(30, "2026-10-18")).toBe("2026-09-18");
  expect(daysAgo(1, "2026-03-01")).toBe("2026-02-28");
  expect(daysAgo(0, "2026-10-18")).toBe("2026-10-18");
});

it("links one budget account to each SimpleFIN account", () => {
  let b = produce(usd(), (d) => linkAccount(d, checking, "checking", "2026-09-18"));
  expect(b.accounts.find((a) => a.id === "checking")?.simplefin).toEqual({
    id: "ACT-1",
    name: "Everyday Checking",
    org: "First Bank",
    from: "2026-09-18",
  });
  // Choosing another account moves the link; choosing none removes it.
  b = produce(b, (d) => linkAccount(d, checking, "savings", "2026-09-18"));
  expect(b.accounts.filter((a) => a.simplefin).map((a) => a.id)).toEqual(["savings"]);
  b = produce(b, (d) => linkAccount(d, checking, null));
  expect(b.accounts.some((a) => a.simplefin)).toBe(false);
  // A linked account SimpleFIN hasn't listed this session still shows, by its saved name.
  b = produce(b, (d) => linkAccount(d, checking, "checking", "2026-09-18"));
  expect(listedAccounts(b, []).map((a) => [a.id, a.name, a.org])).toEqual([["ACT-1", "Everyday Checking", "First Bank"]]);
  expect(listedAccounts(b, [checking])).toHaveLength(1);
});

function Settings({ initial = usd() }: { initial?: Budget }) {
  const [budget, setBudget] = useState(initial);
  return (
    <ToastProvider>
      <BankSyncSettings budget={budget} edit={(update) => setBudget((b) => produce(b, update))} onSync={onSync} />
      <output data-testid="links">{JSON.stringify(budget.accounts.map((a) => a.simplefin ?? null))}</output>
    </ToastProvider>
  );
}
const onSync = vi.fn();
const links = () => JSON.parse(screen.getByTestId("links").textContent!) as unknown[];

it("connects with a pasted setup token", async () => {
  vi.mocked(simplefin.status).mockResolvedValue(status({ connected: false, accounts: [] }));
  vi.mocked(simplefin.connect).mockResolvedValue(status());
  render(<Settings />);
  expect(await screen.findByText(/a subscription you pay SimpleFIN for/)).toBeTruthy();
  expect(screen.getByText(/never in the budget file/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open SimpleFIN Bridge" }));
  expect(simplefin.openBridge).toHaveBeenCalled();
  const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: " aHR0cHM6Ly9leGFtcGxl " } });
  fireEvent.click(connect);
  await screen.findByText(/Connected to SimpleFIN Bridge/);
  expect(simplefin.connect).toHaveBeenCalledWith(" aHR0cHM6Ly9leGFtcGxl ");
  expect(screen.getByText("Everyday Checking")).toBeTruthy();
});

it("says plainly why a token didn't connect", async () => {
  vi.mocked(simplefin.status).mockResolvedValue(status({ connected: false, accounts: [] }));
  vi.mocked(simplefin.connect).mockRejectedValue("That setup token was already used.");
  render(<Settings />);
  fireEvent.change(await screen.findByLabelText("Setup token"), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("That setup token was already used.")).toBeTruthy();
});

it("chooses the account each bank account syncs into, from a date", async () => {
  vi.mocked(simplefin.status).mockResolvedValue(status({ messages: ["First Bank: Sign in again."] }));
  render(<Settings />);
  expect(await screen.findByText("First Bank: Sign in again.")).toBeTruthy();
  expect(screen.getByText("Used today: 2 of 20.", { exact: false })).toBeTruthy();
  // An account in another currency can't be linked.
  expect(screen.getByText("In EUR; this budget uses USD")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Account for Everyday Checking"), { target: { value: "checking" } });
  expect(links()[0]).toMatchObject({ id: "ACT-1", from: daysAgo(30) });
  expect(screen.getByLabelText("First day to bring in for Everyday Checking")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  expect(onSync).toHaveBeenCalled();
  // A card can be told its bank sends purchases as money in.
  fireEvent.change(screen.getByLabelText("Account for Everyday Checking"), { target: { value: "credit" } });
  fireEvent.click(screen.getByLabelText("Purchases arrive as money in"));
  expect(links()[2]).toMatchObject({ id: "ACT-1", flipSigns: true });
  expect(links()[0]).toBeNull();
});

it("labels bank balances with their source currency and leaves unknown currency unlabelled", async () => {
  vi.mocked(simplefin.status).mockResolvedValue(status({
    accounts: [checking, euro, { ...euro, id: "ACT-3", name: "Other units", currency: null, balance: 250 }],
  }));
  render(<Settings />);
  await screen.findByText("Everyday Checking");
  const balance = (name: string) => within(screen.getByText(name).closest("tr")!).getAllByRole("cell")[1].textContent;
  expect(balance("Everyday Checking")).toBe("$1,520.15");
  expect(balance("Euro Savings")).toBe("€1.00");
  expect(balance("Other units")).toBe("2.50");
});

it("respects hidden currency for source bank balances", async () => {
  const initial = { ...usd(), numberFormat: { decimal: "." as const, group: "," as const, symbol: "none" as const } };
  configureFormat(initial);
  vi.mocked(simplefin.status).mockResolvedValue(status());
  render(<Settings initial={initial} />);
  await screen.findByText("Euro Savings");
  const row = screen.getByText("Euro Savings").closest("tr")!;
  expect(within(row).getAllByRole("cell")[1].textContent).toBe("1.00");
});

it("removes the connection and unlinks the accounts", async () => {
  const b = produce(usd(), (d) => linkAccount(d, checking, "checking", "2026-09-18"));
  vi.mocked(simplefin.status).mockResolvedValue(status());
  vi.mocked(simplefin.disconnect).mockResolvedValue(status({ connected: false, accounts: [] }));
  render(<Settings initial={b} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove connection" }));
  expect(screen.getByText(/Transactions already imported stay/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
  await screen.findByLabelText("Setup token");
  expect(simplefin.disconnect).toHaveBeenCalled();
  expect(links().every((l) => l === null)).toBe(true);
});

const row = (id: string, payee: string, amount: number, duplicate = false) => ({
  id,
  date: "2026-10-12",
  payee,
  memo: "",
  amount,
  duplicate,
  candidates: [],
});
const review = (accountId: string, rows: ReturnType<typeof row>[], over: Partial<AccountReview> = {}): AccountReview => ({
  accountId,
  name: `Bank ${accountId}`,
  rows,
  balance: -21234,
  balanceDate: "2026-10-18",
  error: null,
  ...over,
});
const synced = (reviews: AccountReview[], messages: string[] = []): Synced => ({
  reviews,
  messages,
  through: "2026-10-18",
  requestsToday: 3,
  dailyLimit: 20,
});

function Dialog({
  first,
  close = vi.fn(),
  onAsk,
  initial = usd(),
}: {
  first?: string;
  close?: () => void;
  onAsk?: (account: { name: string }, problem: string) => void;
  initial?: Budget;
}) {
  const [budget, setBudget] = useState(initial);
  return (
    <ToastProvider>
      <BankSync
        budget={budget}
        balances={new Map()}
        first={first}
        transform={async (work) => setBudget(await work(budget))}
        close={close}
        onAsk={onAsk}
      />
    </ToastProvider>
  );
}

it("reviews each account with something new, starting with the one asked for", async () => {
  const first = synced([
    review("checking", [row("c1", "Grocery store", -4000)]),
    review("credit", [row("k1", "Restaurant", -6234), row("k0", "Coffee", -500, true)]),
    review("savings", [row("s0", "Interest", 12, true)]),
  ]);
  // After savings is marked up to date, and after each import, the rows are checked again.
  vi.mocked(simplefin.sync)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(synced([review("checking", [row("c1", "Grocery store", -4000)]), review("credit", [row("k1", "Restaurant", -6234, true)])]))
    .mockResolvedValueOnce(synced([review("checking", [row("c1", "Grocery store", -4000, true)]), review("credit", [row("k1", "Restaurant", -6234, true)])]));
  vi.mocked(simplefin.import).mockImplementation(async (b) => ({ ...b }));
  const close = vi.fn();
  render(<Dialog first="credit" close={close} />);
  expect(screen.getByText(/Getting your transactions from SimpleFIN/)).toBeTruthy();
  // Savings had nothing new: it's marked synced without a review.
  expect(await screen.findByText(/Bank credit/)).toBeTruthy();
  expect(simplefin.sync).toHaveBeenNthCalledWith(1, expect.anything(), true);
  expect(simplefin.import).toHaveBeenNthCalledWith(1, expect.anything(), "savings", [], "2026-10-18");
  expect(screen.getByText("1 more after this")).toBeTruthy();
  expect(screen.getByText(/The bank's balance:/).textContent).toContain("-$212.34");
  expect(screen.getByText("Requests to SimpleFIN today: 3 of 20.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  expect(await screen.findByText(/Bank checking/)).toBeTruthy();
  expect(simplefin.import).toHaveBeenNthCalledWith(
    2,
    expect.anything(),
    "credit",
    [
      { row: expect.objectContaining({ id: "k1" }), action: "new", matchId: null },
      { row: expect.objectContaining({ id: "k0" }), action: "skip", matchId: null },
    ],
    "2026-10-18",
  );
  // Rows are checked again without another download.
  expect(simplefin.sync).toHaveBeenLastCalledWith(expect.anything(), false);
  fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(vi.mocked(simplefin.sync).mock.calls.filter(([, refresh]) => refresh)).toHaveLength(1);
});

it("skips an account for now and shows what SimpleFIN said", async () => {
  vi.mocked(simplefin.sync).mockResolvedValue(
    synced(
      [
        review("checking", [row("c1", "Grocery store", -4000)]),
        review("credit", [], { error: "Rewards Card is in EUR, but this budget uses USD." }),
      ],
      ["You're nearing your daily request limit."],
    ),
  );
  render(<Dialog />);
  expect(await screen.findByText("You're nearing your daily request limit.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Skip this account" }));
  expect(await screen.findByText("Nothing new to import.")).toBeTruthy();
  const summary = screen.getByRole("list");
  expect(within(summary).getByText("Skipped for now.")).toBeTruthy();
  expect(within(summary).getByText("Rewards Card is in EUR, but this budget uses USD.")).toBeTruthy();
  expect(simplefin.import).not.toHaveBeenCalled();
});

it("says plainly when the sync can't start", async () => {
  vi.mocked(simplefin.sync).mockRejectedValue(
    "SimpleFIN needs a payment before it sends more. Check your subscription at SimpleFIN Bridge, then sync again.",
  );
  const close = vi.fn();
  render(<Dialog close={close} />);
  expect(await screen.findByText(/SimpleFIN needs a payment before it sends more/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalled();
});

it("offers the assistant when a card's rows all come in as money in", async () => {
  vi.mocked(simplefin.sync).mockResolvedValue(
    synced([review("credit", [row("k1", "Restaurant", 6234), row("k2", "Grocer", 4000), row("k3", "Fuel", 5000)])]),
  );
  const ask = vi.fn();
  render(<Dialog onAsk={ask} />);
  expect(await screen.findByText(/Every new row from this card came in as money in/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ id: "credit" }), "Every new row from the card came in as money in.");
  expect(syncHelpText("Visa", "Every new row from the card came in as money in.")).toBe(
    "Help me with bank sync for Visa. The sync said: Every new row from the card came in as money in. Check how it's linked, when it last synced, and whether its balance and signs look right.",
  );
});

it("marks a linked account that hasn't synced in a week", () => {
  const account = usd().accounts[0];
  expect(staleSync({ ...account, simplefin: { id: "A", from: "2026-10-01" } }, "2026-10-18")).toBe(true);
  expect(staleSync({ ...account, simplefin: { id: "A", from: "2026-10-01", lastSync: "2026-10-12" } }, "2026-10-18")).toBe(false);
  expect(staleSync({ ...account, simplefin: { id: "A", from: "2026-10-01", lastSync: "2026-10-10" } }, "2026-10-18")).toBe(true);
});

function Details({ onSync = vi.fn(), onAsk = vi.fn(), close = vi.fn() }) {
  const [budget, setBudget] = useState(() =>
    produce(usd(), (d) => {
      const card = d.accounts.find((a) => a.id === "credit")!;
      card.simplefin = { id: "ACT-9", name: "Rewards Card", org: "First Bank", from: "2026-09-01", lastSync: "2026-10-15" };
    }),
  );
  const account = budget.accounts.find((a) => a.id === "credit")!;
  return (
    <ToastProvider>
      <BankSyncDetails
        budget={budget}
        account={account}
        balances={new Map([["credit", { id: "credit", balance: -21234, cleared: -21234, uncleared: 0 }]])}
        edit={(update) => setBudget((b) => produce(b, update))}
        onSync={onSync}
        onSettings={vi.fn()}
        onAsk={onAsk}
        close={close}
      />
      <output data-testid="link">{JSON.stringify(account.simplefin ?? null)}</output>
    </ToastProvider>
  );
}

it("shows how an account syncs, beside the bank's balance", async () => {
  vi.mocked(simplefin.status).mockResolvedValue(
    status({ accounts: [{ id: "ACT-9", name: "Rewards Card", org: "First Bank", currency: "USD", balance: 21234, balanceDate: "2026-10-18" }] }),
  );
  const onSync = vi.fn();
  const onAsk = vi.fn();
  render(<Details onSync={onSync} onAsk={onAsk} />);
  expect(screen.getByText("Rewards Card")).toBeTruthy();
  expect(screen.getByText("First Bank")).toBeTruthy();
  expect(screen.getByText("As the bank sends them")).toBeTruthy();
  expect(await screen.findByText("SimpleFIN Bridge · 2 of 20 requests today")).toBeTruthy();
  // The next sync starts a week before the last.
  expect(screen.getByText(/Brings in what posted from .*2026.* on/)).toBeTruthy();
  // A card balance with the opposite sign to the bank's is pointed out.
  expect(screen.getByText(/have opposite signs/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Sync now/ }));
  expect(onSync).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Ask the assistant/ }));
  expect(onAsk).toHaveBeenCalled();
});

it("keeps a mismatched bank balance in its source currency in account details", async () => {
  vi.mocked(simplefin.status).mockResolvedValue(status({
    accounts: [{ ...euro, id: "ACT-9", name: "Rewards Card", balance: 21234 }],
  }));
  render(<Details />);
  await screen.findByText(/This bank account is in EUR/);
  expect(screen.getByText("The bank's balance").nextElementSibling?.textContent).toBe("€212.34");
  expect(screen.getByText("UrBudget's balance").nextElementSibling?.textContent).toBe("-$212.34");
});

it("unlinks an account with Undo", async () => {
  vi.mocked(simplefin.status).mockResolvedValue(status({ connected: false, accounts: [] }));
  const close = vi.fn();
  render(<Details close={close} />);
  expect(await screen.findByText(/Not connected on this computer/)).toBeTruthy();
  expect((screen.getByRole("button", { name: /Sync now/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Shown after a sync")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
  expect(close).toHaveBeenCalled();
  expect(screen.getByTestId("link").textContent).toBe("null");
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(JSON.parse(screen.getByTestId("link").textContent!)).toMatchObject({ id: "ACT-9" });
});

it("leaves an account already synced today alone when there's nothing new", async () => {
  const b = produce(usd(), (d) => {
    d.accounts.find((a) => a.id === "savings")!.simplefin = { id: "S", from: "2026-09-01", lastSync: "2026-10-18" };
  });
  vi.mocked(simplefin.sync).mockResolvedValue(synced([review("savings", [row("s0", "Interest", 12, true)])]));
  render(<Dialog initial={b} />);
  expect(await screen.findByText("Nothing new to import.")).toBeTruthy();
  expect(simplefin.import).not.toHaveBeenCalled();
});

it("offers the assistant the synced transactions that came in without a category", async () => {
  vi.mocked(simplefin.sync)
    .mockResolvedValueOnce(synced([review("checking", [row("c1", "Grocery store", -4000)]), review("credit", [], { error: "Gone." })]))
    .mockResolvedValue(synced([review("checking", [row("c1", "Grocery store", -4000, true)]), review("credit", [], { error: "Gone." })]));
  vi.mocked(simplefin.import).mockImplementation(async (b) => ({
    ...b,
    transactions: [
      ...b.transactions,
      { id: "bank:c1", date: "2026-10-12", accountId: "checking", payee: "Grocery store", memo: "", amount: -4000, status: "cleared", splits: [{ categoryId: null, amount: -4000 }], transferAccountId: null, transferStatus: null },
    ],
  }));
  const onCategorize = vi.fn();
  const close = vi.fn();
  render(
    <ToastProvider>
      <SyncDialog onCategorize={onCategorize} close={close} />
    </ToastProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Import 1 transaction" }));
  // The sync ends on its summary (an account failed), which offers the new transaction.
  expect(await screen.findByText("1 new transaction has no category.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Categorize with the assistant" }));
  expect(close).toHaveBeenCalled();
  expect(onCategorize).toHaveBeenCalledWith({ ids: ["bank:c1"], accounts: ["Everyday account"] });
});

it("puts the offer on the toast when a sync closes by itself", async () => {
  vi.mocked(simplefin.sync)
    .mockResolvedValueOnce(synced([review("checking", [row("c1", "Grocery store", -4000)])]))
    .mockResolvedValue(synced([review("checking", [row("c1", "Grocery store", -4000, true)])]));
  vi.mocked(simplefin.import).mockImplementation(async (b) => ({
    ...b,
    transactions: [
      ...b.transactions,
      { id: "bank:c1", date: "2026-10-12", accountId: "checking", payee: "Grocery store", memo: "", amount: -4000, status: "cleared", splits: [{ categoryId: null, amount: -4000 }], transferAccountId: null, transferStatus: null },
    ],
  }));
  const onCategorize = vi.fn();
  render(
    <ToastProvider>
      <SyncDialog onCategorize={onCategorize} />
    </ToastProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Import 1 transaction" }));
  expect(await screen.findByText("Imported 1 transaction from your bank for review.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Categorize with the assistant" }));
  expect(onCategorize).toHaveBeenCalledWith({ ids: ["bank:c1"], accounts: ["Everyday account"] });
});

/** The sync dialog over a budget that changes as it imports. */
function SyncDialog({ onCategorize, close = vi.fn() }: { onCategorize: (u: { ids: string[]; accounts: string[] }) => void; close?: () => void }) {
  const [budget, setBudget] = useState(usd());
  const [open, setOpen] = useState(true);
  return open ? (
    <BankSync
      budget={budget}
      balances={new Map()}
      transform={async (work) => setBudget(await work(budget))}
      close={() => {
        close();
        setOpen(false);
      }}
      onCategorize={onCategorize}
    />
  ) : null;
}
