import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { CategoryPicker, PayeeInput, ToastProvider, useToast } from ".";
import { demoBudget } from "../demo";

afterEach(cleanup);

it("category picker filters by name and group and picks with the keyboard", () => {
  const b = demoBudget();
  const onChange = vi.fn();
  render(<CategoryPicker budget={b} value={null} onChange={onChange} readyToAssign />);
  const input = screen.getByRole("combobox", { name: "Category" });
  fireEvent.change(input, { target: { value: "groc" } });
  const options = screen.getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("Groceries")]);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("groceries", expect.anything());
  // Card payment categories are left out unless asked for.
  fireEvent.change(input, { target: { value: "card" } });
  expect(screen.queryByRole("option", { name: /credit card/i })).toBeNull();
});

it("category picker offers to create a name no category has, but never on Tab", () => {
  const b = demoBudget();
  const onChange = vi.fn();
  const onCreate = vi.fn();
  render(<CategoryPicker budget={b} value={null} onChange={onChange} onCreate={onCreate} />);
  const input = screen.getByRole("combobox", { name: "Category" });
  fireEvent.change(input, { target: { value: "Pet food" } });
  expect(screen.getByRole("option", { name: "Create category “Pet food”" })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Tab" });
  expect(onCreate).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "Pet food " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onCreate).toHaveBeenCalledWith("Pet food");
  expect(onChange).not.toHaveBeenCalled();
  // A name that exists is chosen, not created.
  fireEvent.change(input, { target: { value: "groceries" } });
  expect(screen.queryByRole("option", { name: /Create category/ })).toBeNull();
});

it("category picker offers a new category before anything is typed", () => {
  const onCreate = vi.fn();
  render(<CategoryPicker budget={demoBudget()} value={null} onChange={vi.fn()} onCreate={onCreate} />);
  fireEvent.click(screen.getByRole("combobox", { name: "Category" }));
  const options = screen.getAllByRole("option");
  expect(options.at(-1)!.textContent).toBe("New category…");
  fireEvent.click(options.at(-1)!);
  expect(onCreate).toHaveBeenCalledWith("");
});

it("payee input keeps a new name as typed, and still completes one that starts the same", () => {
  const b = { ...demoBudget(), payees: [{ id: "walmart", name: "Walmart" }] };
  const onPick = vi.fn();
  const onKeyDown = vi.fn();
  function Harness() {
    const [value, setValue] = useState("");
    return <PayeeInput budget={b} value={value} onChange={setValue} onPick={onPick} onKeyDown={onKeyDown} />;
  }
  render(<Harness />);
  const input = screen.getByRole("combobox", { name: "Payee" }) as HTMLInputElement;
  // "Mart" is inside "Walmart", not how it starts: the new payee is the one highlighted.
  fireEvent.change(input, { target: { value: "Mart" } });
  expect(screen.getByRole("option", { name: "Walmart" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "New payee “Mart”" }).className).toContain("active");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input.value).toBe("Mart");
  fireEvent.change(input, { target: { value: "Mart" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("Mart");
  expect(onPick).not.toHaveBeenCalled();
  // Enter goes on to the form (to save), as it does when nothing matches.
  expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));
  fireEvent.change(input, { target: { value: "wal" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("Walmart");
});

it("payee input suggests known payees and reports their last category", () => {
  const b = demoBudget();
  const payee = b.transactions.find((t) => t.payee && t.splits.length === 1)!;
  const onPick = vi.fn();
  function Harness() {
    const [value, setValue] = useState("");
    return <PayeeInput budget={b} value={value} onChange={setValue} onPick={onPick} />;
  }
  render(<Harness />);
  const input = screen.getByRole("combobox", { name: "Payee" });
  fireEvent.change(input, { target: { value: payee.payee.slice(0, 3) } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect((input as HTMLInputElement).value).toBe(payee.payee);
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: payee.payee }));
});

it("toasts show an action and dismiss themselves", () => {
  vi.useFakeTimers();
  const undo = vi.fn();
  function Trigger() {
    const toast = useToast();
    return <button onClick={() => toast({ message: "Deleted 2 transactions", action: { label: "Undo", onClick: undo } })}>go</button>;
  }
  render(
    <ToastProvider>
      <Trigger />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText("go"));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(undo).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("go"));
  expect(screen.getByRole("status").textContent).toContain("Deleted 2 transactions");
  act(() => {
    vi.advanceTimersByTime(6000);
  });
  expect(screen.queryByRole("status")).toBeNull();
  vi.useRealTimers();
});
