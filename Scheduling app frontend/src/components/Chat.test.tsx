import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Chat from "./Chat";

afterEach(cleanup);

describe("Chat", () => {
  it("renders an assistant message", () => {
    render(<Chat messages={[{ role: "assistant", text: "Hello there" }]} busy={false} onSend={() => {}} />);
    expect(screen.getByText("Hello there")).toBeTruthy();
  });

  it("clicking a suggested slot drafts a booking in the composer", () => {
    const slots = [
      { start: new Date(2026, 5, 23, 9, 0).toISOString(), end: new Date(2026, 5, 23, 10, 0).toISOString() },
    ];
    render(<Chat messages={[{ role: "assistant", text: "Open windows:", slots }]} busy={false} onSend={() => {}} />);

    fireEvent.click(screen.getByTitle("Draft a booking at this time"));

    const input = screen.getByPlaceholderText(/Schedule a meeting/) as HTMLInputElement;
    expect(input.value).toMatch(/^Schedule 'Meeting' on /);
  });

  it("submits typed text via onSend", () => {
    const onSend = vi.fn();
    render(<Chat messages={[]} busy={false} onSend={onSend} />);

    const input = screen.getByPlaceholderText(/Schedule a meeting/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "What do I have today?" } });
    fireEvent.submit(input.closest("form")!);

    expect(onSend).toHaveBeenCalledWith("What do I have today?");
  });
});
