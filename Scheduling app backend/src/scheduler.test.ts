// Unit tests for the calendar reasoning engine. Seeds the directory/holidays
// from seedData and builds events directly in the in-memory store (no DB).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events as storeEvents, holidays as storeHolidays, rooms as storeRooms, users as storeUsers } from "./store.js";
import { holidays, rooms, users } from "./seedData.js";
import { attendeeConflicts, findFreeSlots, holidaysOn, roomConflict } from "./scheduler.js";
import type { CalendarEvent } from "./types.js";

beforeAll(() => {
  storeUsers.push(...users);
  storeRooms.push(...rooms);
  storeHolidays.push(...holidays);
});

beforeEach(() => {
  storeEvents.length = 0; // fresh calendar per test
});

const iso = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).toISOString();

function makeEvent(p: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e",
    title: "Meeting",
    agenda: "",
    start: iso(2026, 5, 22, 10),
    end: iso(2026, 5, 22, 11),
    organizerId: "u_me",
    attendeeIds: ["u_me"],
    roomId: null,
    type: "meeting",
    status: "confirmed",
    priority: "operational",
    createdAt: "",
    updatedAt: "",
    ...p,
  };
}

describe("attendeeConflicts", () => {
  it("detects an overlapping meeting for a shared attendee", () => {
    storeEvents.push(makeEvent({ id: "a", start: iso(2026, 5, 22, 10), end: iso(2026, 5, 22, 11), attendeeIds: ["u_me", "u_anna"] }));
    const conflicts = attendeeConflicts(["u_me"], iso(2026, 5, 22, 10, 30), iso(2026, 5, 22, 11, 30));
    expect(conflicts).toHaveLength(1);
  });

  it("returns nothing when times do not overlap", () => {
    storeEvents.push(makeEvent({ id: "a", start: iso(2026, 5, 22, 10), end: iso(2026, 5, 22, 11) }));
    expect(attendeeConflicts(["u_me"], iso(2026, 5, 22, 11), iso(2026, 5, 22, 12))).toHaveLength(0);
  });

  it("ignores a different attendee", () => {
    storeEvents.push(makeEvent({ id: "a", attendeeIds: ["u_anna"] }));
    expect(attendeeConflicts(["u_kasia"], iso(2026, 5, 22, 10), iso(2026, 5, 22, 11))).toHaveLength(0);
  });

  it("ignores cancelled events", () => {
    storeEvents.push(makeEvent({ id: "a", status: "cancelled" }));
    expect(attendeeConflicts(["u_me"], iso(2026, 5, 22, 10), iso(2026, 5, 22, 11))).toHaveLength(0);
  });
});

describe("roomConflict", () => {
  it("flags a room already booked at that time", () => {
    storeEvents.push(makeEvent({ id: "a", roomId: "r_mia", start: iso(2026, 5, 22, 10), end: iso(2026, 5, 22, 11) }));
    expect(roomConflict("r_mia", iso(2026, 5, 22, 10, 30), iso(2026, 5, 22, 11, 30))).toBeTruthy();
    expect(roomConflict("r_ny", iso(2026, 5, 22, 10, 30), iso(2026, 5, 22, 11, 30))).toBeFalsy();
  });
});

describe("findFreeSlots", () => {
  it("returns slots that avoid an existing booking", () => {
    storeEvents.push(makeEvent({ id: "a", start: iso(2026, 5, 22, 9), end: iso(2026, 5, 22, 10), attendeeIds: ["u_me"] }));
    const slots = findFreeSlots(["u_me"], 30, iso(2026, 5, 22, 9), 3);
    expect(slots.length).toBeGreaterThan(0);
    const blockedStart = new Date(iso(2026, 5, 22, 9)).getTime();
    const blockedEnd = new Date(iso(2026, 5, 22, 10)).getTime();
    for (const s of slots) {
      const start = new Date(s.start).getTime();
      expect(start >= blockedEnd || start < blockedStart).toBe(true);
    }
  });

  it("skips holidays when searching", () => {
    // Dec 25 2026 (Christmas) is a Friday — searching from that morning should
    // not return any Dec 25 slots.
    const slots = findFreeSlots(["u_me"], 30, iso(2026, 11, 25, 9), 3);
    for (const s of slots) expect(s.start.slice(0, 10)).not.toBe("2026-12-25");
  });
});

describe("holidaysOn", () => {
  it("returns the holiday for a known date", () => {
    expect(holidaysOn("2026-12-25T10:00:00").map((h) => h.name)).toContain("Christmas Day");
  });

  it("returns nothing for a normal day", () => {
    expect(holidaysOn("2026-03-10T10:00:00")).toHaveLength(0);
  });
});
