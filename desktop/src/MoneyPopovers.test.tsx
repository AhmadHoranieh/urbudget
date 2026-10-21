import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MoveMoneyPopover } from "./MoneyPopovers";
import { AppliedChangeError } from "./useBudget";
import { demoBudget } from "./demo";
afterEach(cleanup);

it("offers save-only retries after a move was already applied, keeping its fields frozen", async () => {
  const retry = vi.fn().mockRejectedValueOnce(new Error("Still unavailable")).mockResolvedValue(undefined);
  const move = vi.fn().mockRejectedValue(new AppliedChangeError(retry));
  const close = vi.fn();
  render(<MoveMoneyPopover budget={demoBudget()} anchor={{ current: document.body }} source="groceries"
    sourceName="Groceries" available={-1000} balances={new Map()} readyToAssign={10000} onMove={move} onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  await screen.findByRole("button", { name: "Retry saving" });
  expect(screen.getByLabelText("Amount").matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  await screen.findByText("Still unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(move).toHaveBeenCalledTimes(1);
  expect(retry).toHaveBeenCalledTimes(2);
});
