import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateInput } from "./ui";
import { useState } from "react";
import { today } from "./types";

afterEach(cleanup);

it("today and t use the current day when an old transaction date is being edited", () => {
  const onChange = vi.fn();
  render(<DateInput value="2020-01-01" onChange={onChange} />);
  for (const text of ["today", "t"]) {
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: text } });
    expect(onChange).toHaveBeenLastCalledWith(today());
  }
});

it("takes typed dates, steps with the arrow keys, and picks from the calendar", () => {
  const onChange = vi.fn();
  render(<DateInput value="2026-10-15" onChange={onChange} />);
  const input = screen.getByLabelText("Date") as HTMLInputElement;
  expect(input.value).toBe("2026-10-15");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "5 oct" } });
  expect(onChange).toHaveBeenLastCalledWith("2026-10-05");
  fireEvent.change(input, { target: { value: "not a date" } });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  fireEvent.blur(input);
  expect(input.value).toBe("not a date");
  expect(input.checkValidity()).toBe(false);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(onChange).toHaveBeenLastCalledWith("2026-10-16");
  expect(input.checkValidity()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Choose date" }));
  fireEvent.click(screen.getByRole("button", { name: "2026-10-20" }));
  expect(onChange).toHaveBeenLastCalledWith("2026-10-20");
  expect(screen.queryByRole("grid")).toBeNull();
});

it("keeps an invalid date visible and blocks the form until it is corrected", () => {
  const save = vi.fn();
  function Harness() {
    const [date, setDate] = useState("2026-10-15");
    return <form onSubmit={(e) => { e.preventDefault(); save(date); }}>
      <DateInput value={date} onChange={setDate} required />
      <button>Save</button>
    </form>;
  }
  render(<Harness />);
  const input = screen.getByLabelText("Date") as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "2026-02-31" } });
  fireEvent.blur(input);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).not.toHaveBeenCalled();
  expect(input.value).toBe("2026-02-31");
  expect(input.validationMessage).toBe("Enter a valid date.");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "20 Oct" } });
  fireEvent.blur(input);
  expect(input.value).toBe("2026-10-20");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith("2026-10-20");
});

it("clears an optional date instead of restoring its previous value on blur", () => {
  const onChange = vi.fn();
  function Harness() {
    const [date, setDate] = useState("2026-10-15");
    return <DateInput value={date} onChange={(value) => { onChange(value); setDate(value); }} />;
  }
  render(<Harness />);
  const input = screen.getByLabelText("Date") as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(onChange).toHaveBeenLastCalledWith("");
  expect(input.value).toBe("");
  expect(input.checkValidity()).toBe(true);
});
