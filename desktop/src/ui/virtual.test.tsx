import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useVirtualRows } from "./virtual";

afterEach(cleanup);

function List({ count }: { count: number }) {
  const box = useRef<HTMLDivElement>(null);
  const rows = useVirtualRows(box, count, 20, 5);
  return (
    <div ref={box} data-testid="box">
      <div data-testid="before" style={{ height: rows.before }} />
      {Array.from({ length: rows.end - rows.start }, (_, i) => (
        <p key={rows.start + i}>Row {rows.start + i}</p>
      ))}
      <div data-testid="after" style={{ height: rows.after }} />
    </div>
  );
}

it("renders only the rows in view, keeping room for the rest", () => {
  render(<List count={1000} />);
  // jsdom has no layout, so the box counts as 600px tall: 30 rows of 20px, plus 5 below.
  expect(screen.getAllByText(/^Row/).length).toBe(35);
  expect(screen.getByTestId("after").style.height).toBe(`${(1000 - 35) * 20}px`);
  const box = screen.getByTestId("box");
  Object.defineProperty(box, "scrollTop", { value: 10_000, configurable: true });
  fireEvent.scroll(box);
  expect(screen.getByText("Row 500")).toBeTruthy();
  expect(screen.queryByText("Row 0")).toBeNull();
  expect(screen.getByTestId("before").style.height).toBe(`${495 * 20}px`);
});

it("renders remaining rows when a scrolled list shrinks before the browser clamps scrollTop", () => {
  const view = render(<List count={1000} />);
  const box = screen.getByTestId("box");
  Object.defineProperty(box, "scrollTop", { value: 10_000, configurable: true });
  fireEvent.scroll(box);
  view.rerender(<List count={3} />);
  expect(screen.getAllByText(/^Row/).map((row) => row.textContent)).toEqual(["Row 0", "Row 1", "Row 2"]);
  expect(screen.getByTestId("before").style.height).toBe("0px");
});
