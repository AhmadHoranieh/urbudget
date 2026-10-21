import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { assistant } from "./api";
import { ReplyReport } from "./ReplyReport";

vi.mock("./api", () => ({ assistant: { reportReply: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

it("sends nothing until the user explicitly submits the edited excerpt", async () => {
  vi.mocked(assistant.reportReply).mockResolvedValue("rep_reference");
  render(<ReplyReport text="Private balance: 1234. A harmful suggestion." close={vi.fn()} />);
  expect(assistant.reportReply).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Reply to include"), { target: { value: " A harmful suggestion. " } });
  fireEvent.change(screen.getByLabelText("What's wrong? (optional)"), { target: { value: " Please review this. " } });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  await waitFor(() => expect(assistant.reportReply).toHaveBeenCalledExactlyOnceWith("A harmful suggestion.", "Please review this."));
  expect(await screen.findByText("rep_reference")).toBeTruthy();
  expect(screen.queryByText(/Private balance/)).toBeNull();
});

it("lets the user cancel without sending any report", () => {
  const close = vi.fn();
  render(<ReplyReport text="reply" close={close} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalled();
  expect(assistant.reportReply).not.toHaveBeenCalled();
});

it("preserves edits after a network failure and permits an explicit retry", async () => {
  vi.mocked(assistant.reportReply).mockRejectedValueOnce("You're offline.").mockResolvedValueOnce("rep_retried");
  render(<ReplyReport text="reply" close={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("What's wrong? (optional)"), { target: { value: "Unsafe advice" } });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  expect((await screen.findByRole("alert")).textContent).toContain("You're offline.");
  expect((screen.getByLabelText("What's wrong? (optional)") as HTMLTextAreaElement).value).toBe("Unsafe advice");
  expect(assistant.reportReply).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  expect(await screen.findByText("rep_retried")).toBeTruthy();
  expect(assistant.reportReply).toHaveBeenCalledTimes(2);
});

it("limits the initial excerpt and prevents sending a blank report", () => {
  render(<ReplyReport text={"a".repeat(5000)} close={vi.fn()} />);
  const excerpt = screen.getByLabelText("Reply to include") as HTMLTextAreaElement;
  expect(excerpt.value).toHaveLength(4000);
  expect(excerpt.maxLength).toBe(4000);
  fireEvent.change(excerpt, { target: { value: " " } });
  expect((screen.getByRole("button", { name: "Send report" }) as HTMLButtonElement).disabled).toBe(true);
});

it("does not split an emoji when truncating the initial excerpt", () => {
  render(<ReplyReport text={`${"a".repeat(3999)}😀`} close={vi.fn()} />);
  expect((screen.getByLabelText("Reply to include") as HTMLTextAreaElement).value).toBe("a".repeat(3999));
});
