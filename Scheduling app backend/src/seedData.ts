// Initial demo data inserted by `npm run db:setup`. Reference rows (people,
// rooms, holidays, mock emails/files) are static; the sample events are built
// relative to "today" so a fresh seed always has realistic, near-term data for
// the availability / conflict / review demos.
import { nanoid } from "nanoid";
import type { CalendarEvent, EmailMsg, FileDoc, Holiday, Room, User } from "./types.js";

export const users: User[] = [
  { id: "u_me", name: "You (Chief of Staff)", email: "engineering@example.com", department: "Executive", timezone: "America/New_York" },
  { id: "u_anna", name: "Anna Nowak", email: "anna.nowak@example.com", department: "Operations", timezone: "Europe/Warsaw" },
  { id: "u_kasia", name: "Kasia Wójcik", email: "kasia.wojcik@example.com", department: "Finance", timezone: "Europe/Warsaw" },
  { id: "u_tomek", name: "Tomek Lewandowski", email: "tomek.lewandowski@example.com", department: "Engineering", timezone: "Europe/Warsaw" },
  { id: "u_pawel", name: "Paweł Zieliński", email: "pawel.zielinski@example.com", department: "Sales", timezone: "Europe/Warsaw" },
  { id: "u_joanna", name: "Joanna Kowalska", email: "joanna.kowalska@example.com", department: "Marketing", timezone: "Europe/Warsaw" },
  // Two John Smiths in different departments — the ambiguity case from the spec.
  { id: "u_john_a", name: "John Smith", email: "john.smith.a@example.com", department: "Team A", timezone: "America/Los_Angeles" },
  { id: "u_john_b", name: "John Smith", email: "john.smith.b@example.com", department: "Team B", timezone: "America/Chicago" },
];

export const rooms: Room[] = [
  { id: "r_van", name: "CONF NOR Port of Vancouver", capacity: 8, location: "Vancouver" },
  { id: "r_vir", name: "CONF NOR Port of Virginia", capacity: 10, location: "Virginia" },
  { id: "r_mia", name: "CONF NOR Port of Miami", capacity: 6, location: "Miami" },
  { id: "r_la", name: "CONF NOR Port of Los Angeles", capacity: 12, location: "Los Angeles" },
  { id: "r_ny", name: "CONF NOR Port of New York", capacity: 14, location: "New York" },
];

// 2026 US federal holidays + a couple of Home Office (company) holidays.
export const holidays: Holiday[] = [
  { date: "2026-01-01", name: "New Year's Day", region: "US" },
  { date: "2026-01-19", name: "Martin Luther King Jr. Day", region: "US" },
  { date: "2026-02-16", name: "Presidents' Day", region: "US" },
  { date: "2026-05-25", name: "Memorial Day", region: "US" },
  { date: "2026-06-19", name: "Juneteenth", region: "US" },
  { date: "2026-07-03", name: "Independence Day (observed)", region: "US" },
  { date: "2026-09-07", name: "Labor Day", region: "US" },
  { date: "2026-11-26", name: "Thanksgiving", region: "US" },
  { date: "2026-12-25", name: "Christmas Day", region: "US" },
  { date: "2026-06-26", name: "Company Offsite (Home Office closed)", region: "HO" },
  { date: "2026-08-14", name: "Summer Recharge Day", region: "HO" },
];

// Mock recent emails + files the prep-builder pulls relevant context from.
export const emails: EmailMsg[] = [
  { from: "u_pawel", subject: "Q3 forecast numbers", snippet: "Latest pipeline + risk adjustments attached.", date: "2026-06-17", tags: ["finance", "forecast", "q3", "budget", "review"] },
  { from: "u_anna", subject: "Ops KPIs — week 24", snippet: "Throughput up 4%, two blockers flagged for sync.", date: "2026-06-16", tags: ["ops", "kpi", "operational", "sync", "weekly"] },
  { from: "u_kasia", subject: "1:1 topics", snippet: "Career goals + comp review for next quarter.", date: "2026-06-15", tags: ["career", "finance", "development"] },
  { from: "u_tomek", subject: "Standup notes", snippet: "Deploy pipeline green, one flaky test to chase.", date: "2026-06-18", tags: ["standup", "status", "engineering"] },
];

export const files: FileDoc[] = [
  { name: "Q3_Forecast_v3.xlsx", owner: "u_pawel", tags: ["finance", "forecast", "q3", "budget", "review"] },
  { name: "Ops_KPI_Dashboard.pdf", owner: "u_anna", tags: ["ops", "kpi", "sync", "weekly"] },
  { name: "Career_Framework.pdf", owner: "u_kasia", tags: ["career", "development"] },
];

// Build a few existing events relative to "today" so availability/conflict/
// review demos have realistic data the moment the database is seeded.
export function buildSeedEvents(): CalendarEvent[] {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const at = (dayOffset: number, hour: number, min = 0) => {
    const d = new Date(base);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, min, 0, 0);
    return d.toISOString();
  };
  const stamp = new Date().toISOString();
  const make = (e: Omit<CalendarEvent, "id" | "createdAt" | "updatedAt">): CalendarEvent => ({
    ...e,
    id: nanoid(8),
    createdAt: stamp,
    updatedAt: stamp,
  });

  return [
    make({
      title: "Weekly Ops Sync",
      agenda: "Review operational KPIs and blockers.",
      start: at(0, 10, 0),
      end: at(0, 11, 0),
      organizerId: "u_me",
      attendeeIds: ["u_me", "u_anna"],
      roomId: "r_ny",
      type: "meeting",
      status: "confirmed",
      priority: "operational",
    }),
    make({
      title: "Finance Review with Paweł",
      agenda: "Q3 forecast walkthrough.",
      start: at(2, 14, 0),
      end: at(2, 15, 0),
      organizerId: "u_me",
      attendeeIds: ["u_me", "u_pawel"],
      roomId: "r_vir",
      type: "meeting",
      status: "confirmed",
      priority: "strategic",
    }),
    make({
      title: "Kasia 1:1",
      agenda: "Career development check-in.",
      start: at(1, 9, 30),
      end: at(1, 10, 0),
      organizerId: "u_me",
      attendeeIds: ["u_me", "u_kasia"],
      roomId: null,
      type: "meeting",
      status: "confirmed",
      priority: "operational",
    }),
    make({
      title: "Recurring Status Standup",
      agenda: "Daily standup — often runs short, low signal.",
      start: at(1, 8, 30),
      end: at(1, 9, 0),
      organizerId: "u_me",
      attendeeIds: ["u_me", "u_tomek", "u_anna"],
      roomId: null,
      type: "meeting",
      status: "confirmed",
      priority: "low",
    }),
  ];
}
