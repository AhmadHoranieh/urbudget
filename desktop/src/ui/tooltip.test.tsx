import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipLayer } from ".";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pointer = (type: string, target: Element, relatedTarget: Element | null = null) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget, clientX: 10 }));
  });
const flush = () => act(async () => {});

it("shows a title in the styled tooltip after a pause, and puts the title back on leaving", async () => {
  render(
    <>
      <button title="Rename (F2)">Rename</button>
      <button title="More">More</button>
      <TooltipLayer />
    </>,
  );
  const [rename, more] = screen.getAllByRole("button");
  pointer("pointerover", rename);
  // The system tooltip is kept away while the pointer is over the button.
  expect(rename.getAttribute("title")).toBe("");
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByRole("tooltip").textContent).toBe("Rename (F2)");

  // Moving straight to the next button shows its tooltip at once.
  pointer("pointerout", rename, more);
  pointer("pointerover", more, rename);
  expect(rename.getAttribute("title")).toBe("Rename (F2)");
  expect(screen.getByRole("tooltip").textContent).toBe("More");

  pointer("pointerdown", more);
  expect(screen.queryByRole("tooltip")).toBeNull();
  pointer("pointerout", more, document.body);
  expect(more.getAttribute("title")).toBe("More");
  await flush();
});

it("follows a title the page changes or drops while it is hovered", async () => {
  function Harness({ title }: { title?: string }) {
    return (
      <>
        <button title={title}>Sort</button>
        <TooltipLayer />
      </>
    );
  }
  const { rerender } = render(<Harness title="Sort by date" />);
  const button = screen.getByRole("button");
  pointer("pointerover", button);
  act(() => vi.advanceTimersByTime(500));
  rerender(<Harness title="Sorted by date" />);
  await flush();
  expect(screen.getByRole("tooltip").textContent).toBe("Sorted by date");
  expect(button.getAttribute("title")).toBe("");

  rerender(<Harness />);
  await flush();
  expect(screen.queryByRole("tooltip")).toBeNull();
  pointer("pointerout", button, document.body);
  expect(button.hasAttribute("title")).toBe(false);
});

it("shows the tooltip when Tab moves focus to a titled control, leaving its title alone", () => {
  render(
    <>
      <button title="Undo (Ctrl+Z)">Undo</button>
      <TooltipLayer />
    </>,
  );
  const button = screen.getByRole("button");
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    button.focus();
  });
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByRole("tooltip").textContent).toBe("Undo (Ctrl+Z)");
  expect(button.getAttribute("title")).toBe("Undo (Ctrl+Z)");
  act(() => button.blur());
  expect(screen.queryByRole("tooltip")).toBeNull();
});
