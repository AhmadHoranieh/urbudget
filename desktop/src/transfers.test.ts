import { expect, it } from "vitest";
import { transferView } from "./transfers";

const accounts = new Map([
  ["chk", { name: "Checking", kind: "cash" as const }],
  ["sav", { name: "Savings", kind: "cash" as const }],
  ["visa", { name: "Visa", kind: "credit" as const }],
  ["house", { name: "House", kind: "tracking" as const }],
]);

it("reads a transfer from each side", () => {
  expect(transferView(accounts, "chk", "sav", -5000)?.label).toBe("To: Savings");
  expect(transferView(accounts, "sav", "chk", 5000)?.label).toBe("From: Checking");
  expect(transferView(accounts, "chk", null, -5000)).toBeNull();
});

it("marks money from a budget account to a card as a payment", () => {
  const paying = transferView(accounts, "chk", "visa", -20000);
  expect(paying).toMatchObject({ account: "visa", card: true, label: "To: Visa" });
  expect(transferView(accounts, "visa", "chk", 20000)).toMatchObject({ card: true, label: "From: Checking" });
  // A cash advance, from the card into checking, is an ordinary transfer.
  expect(transferView(accounts, "visa", "chk", -20000)).toMatchObject({ card: false, label: "To: Checking" });
  expect(transferView(accounts, "house", "visa", -100)?.card).toBe(false);
});
