import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Insights from "./Insights";
import type { CalendarEvent } from "../api";

afterEach(cleanup);

const base = (p: Partial<CalendarEvent>): CalendarEvent => ({
  id: "e",
  title: "Meeting",
  agenda: "",
  start: "",
  end: "",
  organizerId: "u_me",
  attendeeIds: ["u_me"],
  roomId: null,
  type: "meeting",
  status: "confirmed",
  priority: "operational",
  createdAt: "",
  updatedAt: "",
  ...p,
});

// A time `days` from now at the given hour, as ISO — keeps events inside the
// "next 7 days" window the panel summarizes.
function at(days: number, hour: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe("Insights", () => {
  it("summarizes this week's meetings, hours, and focus time", () => {
    const events: CalendarEvent[] = [
      base({ id: "1", start: at(1, 10), end: at(1, 11), type: "meeting", priority: "strategic" }),
      base({ id: "2", start: at(2, 14), end: at(2, 15), type: "meeting", priority: "operational" }),
      base({ id: "3", start: at(2, 16), end: at(2, 17), type: "working-session", priority: "strategic" }),
    ];
    render(<Insights events={events} />);
    expect(screen.getByText("This week")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy(); // meeting count
    expect(screen.getByText("2h")).toBeTruthy(); // hours in meetings
    expect(screen.getByText("1h")).toBeTruthy(); // focus time
  });

  it("shows an empty state when there are no meetings", () => {
    render(<Insights events={[]} />);
    expect(screen.getByText(/No meetings in the next 7 days/)).toBeTruthy();
  });
});
