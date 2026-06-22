export interface User {
  id: string;
  name: string;
  email: string;
  department: string;
  timezone: string;
}
export interface Room {
  id: string;
  name: string;
  capacity: number;
  location: string;
}
export interface Holiday {
  date: string;
  name: string;
  region: "US" | "HO";
}
export interface CalendarEvent {
  id: string;
  title: string;
  agenda: string;
  start: string;
  end: string;
  organizerId: string;
  attendeeIds: string[];
  roomId: string | null;
  type: "meeting" | "working-session";
  status: "confirmed" | "cancelled";
  priority: "strategic" | "operational" | "low";
  createdAt: string;
  updatedAt: string;
}
export interface FreeSlot {
  start: string;
  end: string;
}

export interface CommandResponse {
  reply: string;
  intent: string;
  notifications?: string[];
  createdEvent?: CalendarEvent;
  updatedEvent?: CalendarEvent;
  cancelledEvent?: CalendarEvent;
  slots?: FreeSlot[];
  events?: CalendarEvent[];
  needsClarification?: boolean;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface OutlookStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
}

export const api = {
  directory: () => http<{ users: User[]; rooms: Room[]; holidays: Holiday[] }>("/directory"),
  events: () => http<CalendarEvent[]>("/events"),
  command: (text: string) =>
    http<CommandResponse>("/command", { method: "POST", body: JSON.stringify({ text }) }),
  authStatus: () => http<OutlookStatus>("/auth/status"),
  logout: () => http<{ ok: boolean }>("/auth/logout", { method: "POST" }),
};
