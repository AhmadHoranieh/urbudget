import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CardPaymentForm } from "./CardPayment";
import { configureFormat } from "./format";
import { demoBudget } from "./demo";
import { today } from "./types";
import { AppliedChangeError } from "./useBudget";

afterEach(cleanup);

it("reads a custom payment using the budget's decimal comma", async () => {
  configureFormat({ currency: "EUR", numberFormat: { decimal: ",", group: "." } });
  try {
    const { pay } = setup();
    fireEvent.change(screen.getByLabelText("Payment amount"), { target: { value: "12,34" } });
    expect(screen.getByLabelText("Payment amount")).toHaveProperty("value", "12,34");
    fireEvent.click(screen.getByRole("button", { name: "Pay €12,34" }));
    await waitFor(() => expect(pay).toHaveBeenCalledWith(expect.objectContaining({ amount: -1234 })));
  } finally {
    configureFormat({ currency: "SAR" });
  }
});

function setup() {
  const budget = demoBudget();
  const card = budget.accounts.find((a) => a.kind === "credit")!;
  const payment = budget.categories.find((c) => c.paymentAccountId === card.id)!;
  const pay = vi.fn(async () => {});
  render(
    <CardPaymentForm
      budget={budget}
      card={card}
      balances={new Map([[card.id, { balance: -219075 }], ["checking", { balance: 1260660 }], ["savings", { balance: 4250000 }]])}
      available={new Map([[payment.id, 150000]])}
      close={() => {}}
      pay={pay}
    />,
  );
  return { card, pay };
}

it("offers what's set aside, the whole balance, or another amount", () => {
  setup();
  expect(screen.getByRole("radio", { name: /What's set aside/ })).toHaveProperty("checked", true);
  expect(screen.getByText("2,190.75 SAR", { selector: ".pay-facts strong" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pay 1,500.00 SAR" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /The whole balance/ }));
  expect(screen.getByRole("button", { name: "Pay 2,190.75 SAR" })).toBeTruthy();
});

it("pays the card with a transfer from the chosen account", async () => {
  const { card, pay } = setup();
  // Typing another amount chooses it.
  fireEvent.change(screen.getByLabelText("Payment amount"), { target: { value: "500" } });
  expect(screen.getByRole("radio", { name: /Another amount/ })).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("button", { name: "Pay 500.00 SAR" }));
  await waitFor(() => expect(pay).toHaveBeenCalled());
  expect(pay).toHaveBeenCalledWith(
    expect.objectContaining({
      // Not the savings account, though it holds more.
      accountId: "checking",
      transferAccountId: card.id,
      amount: -50000,
      date: today(),
      payee: "",
      splits: [],
    }),
  );
});

it.each(["aside", "balance"])("retries a failed %s payment with the same ID and amount even if its draft changed the balances", async (choice) => {
  const budget = demoBudget();
  const card = budget.accounts.find((a) => a.kind === "credit")!;
  const payment = budget.categories.find((c) => c.paymentAccountId === card.id)!;
  const pay = vi.fn().mockRejectedValueOnce(new Error("Disk unavailable")).mockResolvedValue(undefined);
  const props = { budget, card, pay, close: () => {} };
  const view = render(<CardPaymentForm {...props}
    balances={new Map([[card.id, { balance: -20000 }], ["checking", { balance: 50000 }]])}
    available={new Map([[payment.id, 10000]])} />);
  if (choice === "balance") fireEvent.click(screen.getByRole("radio", { name: /The whole balance/ }));
  const expectedAmount = choice === "balance" ? -20000 : -10000;
  fireEvent.click(screen.getByRole("button", { name: /^Pay / }));
  await screen.findByText("Disk unavailable");
  const first = pay.mock.calls[0][0];
  expect(first.amount).toBe(expectedAmount);
  // A failed persistence step can leave the payment in the app's recoverable draft.
  view.rerender(<CardPaymentForm {...props}
    balances={new Map([[card.id, { balance: -20000 - expectedAmount }], ["checking", { balance: 50000 + expectedAmount }]])}
    available={new Map([[payment.id, 10000 + expectedAmount]])} />);
  fireEvent.click(screen.getByRole("button", { name: /^Pay / }));
  await waitFor(() => expect(pay).toHaveBeenCalledTimes(2));
  expect(pay.mock.calls[1][0]).toMatchObject({ id: first.id, amount: expectedAmount });
});

it("retries only saving after a card payment is already applied", async () => {
  const { pay } = setup();
  const retry = vi.fn().mockRejectedValueOnce(new Error("Still unavailable")).mockResolvedValue(undefined);
  pay.mockRejectedValueOnce(new AppliedChangeError(retry));
  fireEvent.click(screen.getByRole("button", { name: /^Pay / }));
  await screen.findByRole("button", { name: "Retry saving" });
  expect(screen.getByLabelText("Payment amount").matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  await screen.findByText("Still unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
  expect(pay).toHaveBeenCalledTimes(1);
});
