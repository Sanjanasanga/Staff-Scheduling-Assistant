import { useMemo } from "react";
import type { CalendarEvent, Holiday, Room, User } from "../api";

// Groups upcoming confirmed events by day and renders a simple agenda list with
// holiday markers. Lightweight stand-in for an Outlook calendar surface.
export default function CalendarPanel({
  events,
  dir,
}: {
  events: CalendarEvent[];
  dir: { users: User[]; rooms: Room[]; holidays: Holiday[] };
}) {
  const userName = (id: string) => dir.users.find((u) => u.id === id)?.name ?? id;
  const roomName = (id: string | null) => dir.rooms.find((r) => r.id === id)?.name;
  const holidaysFor = (dayKey: string) => dir.holidays.filter((h) => h.date === dayKey);

  const days = useMemo(() => {
    const sorted = [...events].sort((a, b) => +new Date(a.start) - +new Date(b.start));
    const map = new Map<string, CalendarEvent[]>();
    for (const e of sorted) {
      const key = e.start.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return [...map.entries()];
  }, [events]);

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const fmtDay = (key: string) =>
    new Date(key + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });

  return (
    <div className="panel calendar">
      <h3>Calendar</h3>
      {days.length === 0 && <p className="empty">No upcoming events.</p>}
      {days.map(([key, list]) => (
        <div key={key} className="day">
          <div className="day-head">
            {fmtDay(key)}
            {holidaysFor(key).map((h) => (
              <span key={h.name} className={`tag ${h.region === "US" ? "us" : "ho"}`}>
                {h.name}
              </span>
            ))}
          </div>
          {list.map((e) => (
            <div key={e.id} className={`event ${e.type} prio-${e.priority}`}>
              <div className="time">
                {fmtTime(e.start)}–{fmtTime(e.end)}
              </div>
              <div className="body">
                <div className="etitle">
                  {e.title}
                  <span className={`prio-pill ${e.priority}`}>{e.priority}</span>
                </div>
                <div className="emeta">
                  {e.attendeeIds.map(userName).join(", ")}
                  {roomName(e.roomId) ? ` · 📍 ${roomName(e.roomId)}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
