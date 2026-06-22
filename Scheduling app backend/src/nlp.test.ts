// Unit tests for the rule-based parser. We seed the in-memory directory from
// seedData (no database needed) so attendee resolution works.
import { beforeAll, describe, expect, it } from "vitest";
import { holidays as storeHolidays, rooms as storeRooms, users as storeUsers } from "./store.js";
import { holidays, rooms, users } from "./seedData.js";
import { parseCommand } from "./nlp.js";

// Fixed reference point: Monday, June 22, 2026, 09:00 local.
const NOW = new Date(2026, 5, 22, 9, 0, 0);

beforeAll(() => {
  storeUsers.push(...users);
  storeRooms.push(...rooms);
  storeHolidays.push(...holidays);
});

describe("parseCommand", () => {
  it("parses a create with title, attendees, date/time and agenda", () => {
    const c = parseCommand("Schedule 'Budget Review' with Anna Nowak on Jun 22 at 14:00, agenda: finalize Q3 numbers", NOW);
    expect(c.intent).toBe("create");
    expect(c.title).toBe("Budget Review");
    expect(c.agenda).toMatch(/finalize Q3 numbers/);
    expect(c.attendees.map((a) => a.id)).toEqual(expect.arrayContaining(["u_anna"]));
    expect(c.date?.getDate()).toBe(22);
    expect(c.date?.getHours()).toBe(14);
  });

  it("parses abbreviated month names (regression: Dec 25)", () => {
    const c = parseCommand("Schedule 'Year End' with Anna on Dec 25 at 10:00, agenda: wrap up", NOW);
    expect(c.date?.getMonth()).toBe(11); // December
    expect(c.date?.getDate()).toBe(25);
  });

  it("parses availability with duration and attendees (incl. me)", () => {
    const c = parseCommand("Find a 60-minute window when Kasia, Tomek and I are free", NOW);
    expect(c.intent).toBe("availability");
    expect(c.durationMin).toBe(60);
    expect(c.attendees.map((a) => a.id)).toEqual(expect.arrayContaining(["u_me", "u_kasia", "u_tomek"]));
  });

  it("flags duplicate names as ambiguous (two John Smiths)", () => {
    const c = parseCommand("Remove John Smith from the Ops Sync", NOW);
    expect(c.intent).toBe("remove_participant");
    expect(c.ambiguousNames).toHaveLength(1);
    expect(c.ambiguousNames[0].matches).toHaveLength(2);
  });

  it("disambiguates a duplicate name by department qualifier", () => {
    const c = parseCommand("Remove John Smith Team A from the Ops Sync", NOW);
    expect(c.ambiguousNames).toHaveLength(0);
    expect(c.attendees.map((a) => a.id)).toContain("u_john_a");
  });

  it("parses set_priority with the target priority", () => {
    const c = parseCommand("Mark the Finance Review as strategic", NOW);
    expect(c.intent).toBe("set_priority");
    expect(c.priority).toBe("strategic");
  });

  it("parses a calendar review with scope", () => {
    const c = parseCommand("What do I have scheduled this week?", NOW);
    expect(c.intent).toBe("review");
    expect(c.reviewScope).toBe("week");
  });

  it("routes 'set up a meeting' to create, not set_priority", () => {
    const c = parseCommand("Set up a meeting with Anna on Jun 23 at 11:00, agenda: sync", NOW);
    expect(c.intent).toBe("create");
  });
});
