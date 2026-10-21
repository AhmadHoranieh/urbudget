import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { YnabImport } from "./YnabImport";
import { formatDate, money } from "./format";
afterEach(cleanup);
const plan = (id: string, name: string, lastModifiedOn: string | null = null) => ({ id, name, lastModifiedOn });
const listPlans = () => vi.fn().mockResolvedValue([plan("p", "My budget"), plan("q", "Other")]);
const saved = (id: string, label: string, hint: string, lastUsed: string | null = null) => ({
  id, label, hint, savedAt: "2026-10-01T09:00:00Z", lastUsed,
});
const imported = {
  snapshot: { budget: { name: "My budget", accounts: [{}], transactions: [{}, {}] } },
  elapsedMs: 128,
  backup: "/backup",
  incremental: true,
  unchanged: false,
};
const select = () => screen.getByLabelText("Plan") as HTMLSelectElement;
const importButton = () => screen.getByRole("button", { name: "Import & save" }) as HTMLButtonElement;
/** Pastes a token, then waits for its plans to load. */
async function paste(token: string) {
  fireEvent.change(screen.getByLabelText("YNAB personal access token"), {
    target: { value: token },
  });
  await waitFor(() => expect(select().disabled).toBe(false));
}
it("imports in one submission and leaves a visible success result", async () => {
  const onImport = vi.fn().mockResolvedValue(imported);
  render(<YnabImport onImport={onImport} planId="p" listPlans={listPlans()} tokenStore={null} />);
  await paste("test-secret");
  fireEvent.click(importButton());
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Imported and saved My budget",
    ),
  );
  expect(onImport).toHaveBeenCalledExactlyOnceWith({ token: "test-secret", planId: "p", replace: false });
  expect(
    (screen.getByLabelText("YNAB personal access token") as HTMLInputElement)
      .value,
  ).toBe("");
});
it("says why an import stopped, offers the assistant, and lets it be retried", async () => {
  const onAsk = vi.fn();
  render(
    <YnabImport
      onImport={vi.fn().mockRejectedValue("YNAB split s1 is a transfer to account a, but its counterpart there can't be identified.")}
      onAsk={onAsk}
      listPlans={listPlans()}
      tokenStore={null}
    />,
  );
  await paste("test-secret");
  fireEvent.click(importButton());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The import stopped. Nothing was changed.");
  expect(alert.textContent).toContain("can't be identified");
  fireEvent.click(within(alert).getByRole("button", { name: /Ask the assistant/ }));
  expect(onAsk.mock.calls[0][0]).toContain("My YNAB import of My budget stopped");
  expect(onAsk.mock.calls[0][0]).toContain("can't be identified");
  expect(importButton().disabled).toBe(false);
});

it("shows totals that differ from YNAB and imports them only when accepted", async () => {
  const onAccept = vi.fn().mockResolvedValue(imported);
  const onAsk = vi.fn();
  const differences = [
    { kind: "account", account: "Car Loan", field: "balance", expected: -1083127, actual: -1060000 },
    { kind: "category", category: "Groceries", month: "2026-10", field: "balance", expected: 12936, actual: 2936 },
    { kind: "readyToAssign", month: "2026-10", expected: 31754, actual: 41754 },
  ];
  const onImport = vi.fn().mockResolvedValue({ ...imported, reviewId: "r1", differences });
  render(<YnabImport onImport={onImport} onAccept={onAccept} onAsk={onAsk} listPlans={listPlans()} tokenStore={null} />);
  await paste("secret");
  fireEvent.click(importButton());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("3 totals don't match YNAB");
  expect([...alert.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    `Car Loan balance: ${money(-1060000)} here, ${money(-1083127)} in YNAB`,
    `Groceries, October 2026, available: ${money(2936)} here, ${money(12936)} in YNAB`,
    `Ready to Assign, October 2026: ${money(41754)} here, ${money(31754)} in YNAB`,
  ]);
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: /Import and ask the assistant/ }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Imported and saved"));
  expect(onAccept).toHaveBeenCalledExactlyOnceWith("r1");
  expect(onAsk.mock.calls[0][0]).toContain("I imported My budget from YNAB");
  expect(onAsk.mock.calls[0][0]).toContain(`- Car Loan balance: ${money(-1060000)} here`);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("uses the most recently used saved token, and changes or deletes tokens in a dialog", async () => {
  const listTokens = vi.fn().mockResolvedValue([saved("t1", "Home", "abcd", "2026-10-19T09:00:00Z"), saved("t2", "Work", "wxyz")]);
  const forgetToken = vi.fn().mockResolvedValue(undefined);
  const found = listPlans();
  const onImport = vi.fn().mockResolvedValue(imported);
  render(
    <YnabImport onImport={onImport} listPlans={found} listTokens={listTokens} forgetToken={forgetToken} tokenStore="Credential Manager" />,
  );
  await waitFor(() => expect(select().disabled).toBe(false));
  expect(screen.getByText("Home")).toBeTruthy();
  expect(screen.getByText("••••abcd")).toBeTruthy();
  expect(screen.queryByLabelText("YNAB personal access token")).toBeNull();
  expect(found).toHaveBeenLastCalledWith("", "t1");
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  const dialog = screen.getByRole("dialog", { name: "Saved YNAB tokens" });
  expect(within(dialog).getByText("In use")).toBeTruthy();
  expect(within(dialog).getByText(`••••wxyz · saved ${formatDate("2026-10-01")}`)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Use" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(found).toHaveBeenLastCalledWith("", "t2"));
  fireEvent.click(importButton());
  await waitFor(() => expect(onImport).toHaveBeenCalledExactlyOnceWith({ token: "", planId: "p", replace: false, savedToken: "t2", tokenLabel: "My budget, Other" }));
  // Deleting asks first, then the form falls back to the token that's left.
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  listTokens.mockResolvedValue([saved("t1", "Home", "abcd")]);
  fireEvent.click(screen.getByRole("button", { name: "Delete Work (••••wxyz)" }));
  expect(forgetToken).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(forgetToken).toHaveBeenCalledExactlyOnceWith("t2"));
  await waitFor(() => expect(screen.getAllByText("Home").length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("button", { name: "Paste a different token" }));
  expect(screen.getByLabelText("YNAB personal access token")).toBeTruthy();
});

it("keeps a pasted token when a delayed saved-token listing completes", async () => {
  let finishListing!: (tokens: ReturnType<typeof saved>[]) => void;
  const listTokens = vi.fn(() => new Promise<ReturnType<typeof saved>[]>((resolve) => { finishListing = resolve; }));
  const found = vi.fn(async (_token: string, savedToken?: string) => [
    savedToken ? plan("old", "Old saved plan") : plan("intended", "Intended plan"),
  ]);
  const onImport = vi.fn().mockResolvedValue(imported);
  render(<YnabImport onImport={onImport} listPlans={found} listTokens={listTokens} tokenStore="Keychain" />);
  await paste("one-time-token");
  expect(select().value).toBe("intended");

  await act(async () => finishListing([saved("t1", "Old account", "abcd")]));
  expect((screen.getByLabelText("YNAB personal access token") as HTMLInputElement).value).toBe("one-time-token");
  expect(select().value).toBe("intended");
  fireEvent.click(importButton());
  await waitFor(() => expect(onImport).toHaveBeenCalledExactlyOnceWith({ token: "one-time-token", planId: "intended", replace: false }));
  expect(found).not.toHaveBeenCalledWith("", "t1");
});

it("ignores pending saved-token plans after choosing to paste another token", async () => {
  let finishPlans!: (plans: ReturnType<typeof plan>[]) => void;
  const oldPlans = new Promise<ReturnType<typeof plan>[]>((resolve) => { finishPlans = resolve; });
  const found = vi.fn((_token: string, savedToken?: string) =>
    savedToken ? oldPlans : Promise.resolve([plan("new", "New account's plan")]),
  );
  const onImport = vi.fn().mockResolvedValue(imported);
  render(<YnabImport onImport={onImport} listPlans={found} listTokens={vi.fn().mockResolvedValue([saved("t1", "Old account", "abcd")])} tokenStore="Keychain" />);
  await waitFor(() => expect(found).toHaveBeenCalledWith("", "t1"));
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  fireEvent.click(screen.getByRole("button", { name: "Paste a different token" }));

  await act(async () => finishPlans([plan("old", "Old account's plan")]));
  expect(select().disabled).toBe(true);
  expect(screen.queryByRole("option", { name: "Old account's plan" })).toBeNull();
  expect(importButton().disabled).toBe(true);
  await paste("new-token");
  expect(select().value).toBe("new");
  fireEvent.click(importButton());
  await waitFor(() => expect(onImport).toHaveBeenCalledExactlyOnceWith({ token: "new-token", planId: "new", replace: false }));
});

it("remembers a pasted token under the names of its plans, then uses it", async () => {
  const listTokens = vi.fn().mockResolvedValue([]);
  const onImport = vi.fn().mockResolvedValue({ ...imported, savedToken: "t9" });
  render(<YnabImport onImport={onImport} listPlans={listPlans()} listTokens={listTokens} tokenStore="Credential Manager" />);
  await paste("secret");
  fireEvent.click(screen.getByLabelText("Remember on this device"));
  listTokens.mockResolvedValue([saved("t9", "My budget, Other", "cret")]);
  fireEvent.click(importButton());
  await waitFor(() => expect(screen.getByText("••••cret")).toBeTruthy());
  expect(onImport).toHaveBeenCalledExactlyOnceWith({ token: "secret", planId: "p", replace: false, remember: true, tokenLabel: "My budget, Other" });
});

it("shows competing changes in words: what changed, and each side plainly", async () => {
  render(
    <YnabImport
      onImport={vi.fn().mockResolvedValue({
        reviewId: "review",
        conflicts: [
          { path: "Transaction t.splits", about: "Shop, 2026-10-01, Cash", field: "splits", local: [{ amount: -1500 }], remote: [{ amount: -2000 }], localText: "Food −15.00", remoteText: "Fun −20.00" },
          { path: "Transaction t", about: "Shop, 2026-10-01, Cash", field: null, local: { id: "t" }, remote: null, localText: "Shop, 2026-10-01, Cash, −20.00" },
          { path: "Transaction u.amount", about: "Gym, 2026-10-02, Cash", field: "amount", local: -1500, remote: -2000 },
        ],
      })}
      listPlans={listPlans()}
      tokenStore={null}
    />,
  );
  await paste("test");
  fireEvent.click(importButton());
  await waitFor(() => expect(screen.getByText("Choose which changes to keep")).toBeTruthy());
  const rows = [...document.querySelectorAll(".conflict-review tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].slice(0, 3).map((td) => td.textContent),
  );
  expect(rows).toEqual([
    ["Shop, 2026-10-01, Cashsplit lines", "Food −15.00", "Fun −20.00"],
    ["Shop, 2026-10-01, Cash", "Shop, 2026-10-01, Cash, −20.00", "Deleted"],
    ["Gym, 2026-10-02, Cashamount", money(-1500), money(-2000)],
  ]);
});

it("requires a choice for every import conflict before applying", async () => {
  const onResolve = vi.fn().mockResolvedValue({});
  render(
    <YnabImport
      onResolve={onResolve}
      onImport={vi
        .fn()
        .mockResolvedValue({
          reviewId: "review",
          conflicts: [
            {
              path: "Transaction t.memo",
              local: "My memo",
              remote: "YNAB memo",
            },
          ],
        })}
      listPlans={listPlans()}
      tokenStore={null}
    />,
  );
  await paste("test");
  fireEvent.click(screen.getByText("Import & save"));
  await waitFor(() =>
    expect(screen.getByText("Choose which changes to keep")).toBeTruthy(),
  );
  expect(
    (screen.getByText("Apply reviewed import") as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Resolve Transaction t.memo"), {
    target: { value: "local" },
  });
  fireEvent.click(screen.getByText("Apply reviewed import"));
  await waitFor(() =>
    expect(onResolve).toHaveBeenCalledWith("review", {
      "Transaction t.memo": "local",
    }),
  );
});

it("offers to remember the token in the system's credential store, and nowhere else", () => {
  const { unmount } = render(<YnabImport onImport={vi.fn()} tokenStore="Credential Manager" listTokens={vi.fn().mockResolvedValue([])} />);
  expect(screen.getByLabelText("Remember on this device")).toBeTruthy();
  expect(screen.getByText(/kept in Credential Manager/)).toBeTruthy();
  unmount();
  render(<YnabImport onImport={vi.fn()} tokenStore={null} />);
  expect(screen.queryByLabelText("Remember on this device")).toBeNull();
  expect(screen.getByText(/never stored/)).toBeTruthy();
});

it("lists the token's plans by name, keeping the linked plan or else the newest", async () => {
  const onImport = vi.fn().mockResolvedValue({ ...imported, unchanged: true });
  const found = vi.fn().mockResolvedValue([
    plan("new", "Home", "2026-10-19T08:00:00Z"),
    plan("old", "Home", "2025-03-02T08:00:00Z"),
    plan("work", "Work"),
  ]);
  const { unmount } = render(<YnabImport onImport={onImport} listPlans={found} tokenStore={null} />);
  expect(select().disabled).toBe(true);
  expect(importButton().disabled).toBe(true);
  await paste("secret");
  expect(found).toHaveBeenCalledExactlyOnceWith("secret", undefined);
  expect([...select().options].map((o) => o.textContent)).toEqual([
    `Home · edited ${formatDate("2026-10-19")}`,
    `Home · edited ${formatDate("2025-03-02")}`,
    "Work",
  ]);
  expect(select().value).toBe("new");
  fireEvent.change(select(), { target: { value: "work" } });
  fireEvent.click(screen.getByRole("radio", { name: /Replace this budget/ }));
  fireEvent.click(importButton());
  await waitFor(() => expect(onImport).toHaveBeenCalledExactlyOnceWith({ token: "secret", planId: "work", replace: true }));
  unmount();
  render(<YnabImport onImport={onImport} listPlans={found} planId="old" tokenStore={null} />);
  await paste("secret");
  expect(select().value).toBe("old");
});

it("leaves out the merge or replace choice for a budget with nothing in it", () => {
  const { unmount } = render(<YnabImport onImport={vi.fn()} tokenStore={null} />);
  expect(screen.getByRole("radio", { name: /Replace this budget/ })).toBeTruthy();
  unmount();
  render(<YnabImport onImport={vi.fn()} tokenStore={null} blank />);
  expect(screen.queryByRole("radio")).toBeNull();
});

it("says why plans can't be listed, and won't import without one", async () => {
  render(
    <YnabImport
      onImport={vi.fn()}
      listPlans={vi.fn().mockRejectedValue("YNAB rejected the token. Paste an active personal access token.")}
      tokenStore={null}
    />,
  );
  fireEvent.change(screen.getByLabelText("YNAB personal access token"), { target: { value: "wrong" } });
  expect(await screen.findByText(/YNAB rejected the token/)).toBeTruthy();
  expect(select().disabled).toBe(true);
  expect(importButton().disabled).toBe(true);
});
