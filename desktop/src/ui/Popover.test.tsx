import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Popover } from "./Popover";
import { Menu } from "./Menu";
import { DateInput } from "./DateInput";

afterEach(cleanup);

function Example() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return <><button ref={anchor} onClick={() => setOpen(true)}>Choose</button>
    <input aria-label="Outside" />
    <Popover open={open} onClose={() => setOpen(false)} anchor={anchor}>
      <button>Option</button>
    </Popover></>;
}

it("returns keyboard focus to the trigger after Escape removes the panel", async () => {
  render(<Example />);
  const trigger = screen.getByRole("button", { name: "Choose" });
  trigger.focus();
  fireEvent.click(trigger);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Option" })));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Option" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("does not steal focus when closing after focus moved outside the panel", async () => {
  render(<Example />);
  const trigger = screen.getByRole("button", { name: "Choose" });
  trigger.focus();
  fireEvent.click(trigger);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Option" })));
  const outside = screen.getByRole("textbox", { name: "Outside" });
  outside.focus();
  fireEvent.mouseDown(outside);
  expect(document.activeElement).toBe(outside);
});

it("returns to the date input after Escape closes a calendar that focuses its selected day", async () => {
  render(<DateInput value="2026-10-19" onChange={() => {}} />);
  const date = screen.getByRole("textbox", { name: "Date" });
  date.focus();
  fireEvent.keyDown(date, { key: "ArrowDown", altKey: true });
  const calendar = screen.getByRole("dialog", { name: "Choose date" });
  await waitFor(() => expect(calendar.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Choose date" })).toBeNull();
  expect(document.activeElement).toBe(date);
});

it("returns to the calendar button when it was opened while another field had focus", async () => {
  render(<><input aria-label="Amount" /><DateInput value="2026-10-19" onChange={() => {}} /></>);
  screen.getByRole("textbox", { name: "Amount" }).focus();
  const trigger = screen.getByRole("button", { name: "Choose date" });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  const calendar = screen.getByRole("dialog", { name: "Choose date" });
  await waitFor(() => expect(calendar.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Choose date" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("leaves focus alone when focus management is disabled", async () => {
  function Unfocused() {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return <><button ref={anchor} onClick={() => setOpen(true)}>Trigger</button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} focus={false}>
        <button>Unfocused option</button>
      </Popover></>;
  }
  render(<Unfocused />);
  const trigger = screen.getByRole("button", { name: "Trigger" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Unfocused option" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("closes a menu on a second press of its button, or when the window loses focus", async () => {
  function WithMenu() {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    // A button that only ever opens, as most menu buttons are.
    return <><button ref={anchor} onClick={() => setOpen(true)}>Actions</button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="Actions" items={[{ label: "Rename", onSelect: () => {} }]} /></>;
  }
  render(<WithMenu />);
  const trigger = screen.getByRole("button", { name: "Actions" });
  const press = () => {
    fireEvent.mouseDown(trigger);
    fireEvent.mouseUp(trigger);
    fireEvent.click(trigger);
  };
  press();
  expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
  press();
  expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull();
  // Once that press is over, the button opens the menu again.
  await new Promise((r) => setTimeout(r));
  press();
  expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
  fireEvent.blur(window);
  expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull();
});

it("takes the click that closes a menu, so it doesn't act on what's under it", () => {
  const picked = vi.fn();
  function WithMenu() {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(true);
    return <><button ref={anchor}>Actions</button><button onClick={picked}>Row</button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="Actions" items={[{ label: "Rename", onSelect: () => {} }]} /></>;
  }
  render(<WithMenu />);
  const row = screen.getByRole("button", { name: "Row" });
  fireEvent.mouseDown(row);
  fireEvent.mouseUp(row);
  fireEvent.click(row);
  expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull();
  expect(picked).not.toHaveBeenCalled();
  // With the menu gone, clicks act again.
  return new Promise<void>((done) => setTimeout(() => {
    fireEvent.click(row);
    expect(picked).toHaveBeenCalledTimes(1);
    done();
  }));
});
