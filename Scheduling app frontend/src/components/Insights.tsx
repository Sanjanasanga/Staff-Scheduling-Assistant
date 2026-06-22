import { useMemo } from "react";
import type { CalendarEvent } from "../api";

const ME = "u_me";

// A small "calendar health" summary for the week ahead — the kind of at-a-glance
// view a Chief of Staff cares about: how much time is in meetings, how much is
// protected focus time, and the strategic/operational/low mix.
export default function Insights({ events }: { events: CalendarEvent[] }) {
  const s = useMemo(() => {
    const now = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 7);

    const week = events.filter(
      (e) => e.status === "confirmed" && e.attendeeIds.includes(ME) && new Date(e.start) >= now && new Date(e.start) <= end,
    );
    const hours = (list: CalendarEvent[]) =>
      list.reduce((sum, e) => sum + (new Date(e.end).getTime() - new Date(e.start).getTime()) / 3_600_000, 0);

    const meetings = week.filter((e) => e.type === "meeting");
    const focus = week.filter((e) => e.type === "working-session");
    const prio = { strategic: 0, operational: 0, low: 0 };
    for (const e of meetings) prio[e.priority]++;

    return {
      meetingCount: meetings.length,
      meetingHours: Math.round(hours(meetings) * 10) / 10,
      focusHours: Math.round(hours(focus) * 10) / 10,
      prio,
      total: meetings.length,
    };
  }, [events]);

  const pct = (n: number) => (s.total ? (n / s.total) * 100 : 0);

  return (
    <div className="panel insights">
      <h3>This week</h3>
      <div className="stat-row">
        <div className="stat">
          <span className="num">{s.meetingCount}</span>
          <span className="lbl">meetings</span>
        </div>
        <div className="stat">
          <span className="num">{s.meetingHours}h</span>
          <span className="lbl">in meetings</span>
        </div>
        <div className="stat">
          <span className="num">{s.focusHours}h</span>
          <span className="lbl">focus time</span>
        </div>
      </div>

      {s.total > 0 ? (
        <>
          <div className="prio-bar" title="Meeting mix by priority">
            <span className="seg strategic" style={{ width: `${pct(s.prio.strategic)}%` }} />
            <span className="seg operational" style={{ width: `${pct(s.prio.operational)}%` }} />
            <span className="seg low" style={{ width: `${pct(s.prio.low)}%` }} />
          </div>
          <div className="prio-legend">
            <span><i className="dot strategic" /> {s.prio.strategic} strategic</span>
            <span><i className="dot operational" /> {s.prio.operational} operational</span>
            <span><i className="dot low" /> {s.prio.low} low</span>
          </div>
        </>
      ) : (
        <p className="empty">No meetings in the next 7 days.</p>
      )}
    </div>
  );
}
