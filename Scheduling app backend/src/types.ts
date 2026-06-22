// Shared domain types for the Chief of Staff Scheduling Assistant PoC.

export type MeetingPriority = "strategic" | "operational" | "low";
export type EventType = "meeting" | "working-session";
export type EventStatus = "confirmed" | "cancelled";

export interface User {
  id: string;
  name: string;
  email: string;
  department: string;
  timezone: string; // IANA tz, e.g. "America/New_York"
}

export interface Room {
  id: string;
  name: string;
  capacity: number;
  location: string;
}

export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
  region: "US" | "HO"; // US public holiday | Home Office (company) holiday
}

export interface CalendarEvent {
  id: string;
  title: string;
  agenda: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  organizerId: string;
  attendeeIds: string[];
  roomId: string | null;
  type: EventType;
  status: EventStatus;
  priority: MeetingPriority;
  createdAt: string;
  updatedAt: string;
  // Microsoft Graph event id once mirrored to a real Outlook calendar. Null
  // while running in mock mode or before the event has been synced.
  outlookEventId?: string | null;
}

// A free time window returned by the availability engine.
export interface FreeSlot {
  start: string; // ISO
  end: string; // ISO
}

// Mock context the prep-builder assembles (stands in for the Outlook/Graph mail
// + file-store integrations in a real deployment).
export interface EmailMsg {
  from: string; // user id
  subject: string;
  snippet: string;
  date: string; // YYYY-MM-DD
  tags: string[]; // keywords used for relevance matching
}

export interface FileDoc {
  name: string;
  owner: string; // user id
  tags: string[];
}

// One line in the conversation transcript shown by the chat UI.
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}
