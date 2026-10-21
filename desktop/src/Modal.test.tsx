import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Modal } from "./forms";
afterEach(cleanup);

it("returns focus to the opener even when a child uses autoFocus", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const view = render(<Modal title="Details" close={vi.fn()}><input autoFocus /></Modal>);
  view.unmount();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("focuses an editable field instead of a hidden or disabled input", () => {
  render(<Modal title="Details" close={vi.fn()}><input type="hidden" /><input disabled /><textarea aria-label="Notes" /></Modal>);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Notes" }));
});

it("keeps links inside the keyboard focus loop and ignores disabled/hidden controls", () => {
  render(<Modal title="Details" close={vi.fn()}><input aria-label="Name" /><button tabIndex={-1}>Skipped</button><button hidden>Hidden</button><a href="https://example.com">Help</a></Modal>);
  const first = screen.getByRole("button", { name: "Close dialog" });
  const last = screen.getByRole("link", { name: "Help" });
  first.focus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
});
