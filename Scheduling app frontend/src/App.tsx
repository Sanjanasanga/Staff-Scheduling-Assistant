import { useEffect, useRef, useState } from "react";
import { api, type CalendarEvent, type CommandResponse, type Holiday, type Room, type User } from "./api";
import Chat, { type ChatMessage } from "./components/Chat";
import CalendarPanel from "./components/CalendarPanel";
import Insights from "./components/Insights";

const EXAMPLES = [
  "Schedule 'Budget Review' with Anna Nowak on Jun 22 at 14:00, agenda: finalize Q3 numbers",
  "Find a 60-minute window when Kasia, Tomek and I are free",
  "What do I have scheduled today?",
  "Move my meeting with Paweł from Friday to Monday at 11:00",
  "Cancel the Recurring Status Standup tomorrow",
  "Add Joanna Kowalska to the Weekly Ops Sync",
  "Remove John Smith from the Ops Sync",
  "Book CONF NOR Port of Miami tomorrow at 10:00 for 60 minutes",
  "Block a 90-minute working session tomorrow at 13:00",
  "Plan 6 hours of focus time this week",
  "Mark the Finance Review as strategic",
  "Reprioritize my calendar",
  "Which meetings can I cut?",
  "Who can cover the Weekly Ops Sync?",
  "Prep me for the Finance Review",
];

const WELCOME: ChatMessage = {
  role: "assistant",
  text:
    "👋 Hi — I'm your Chief of Staff scheduling assistant. Tell me what to do in plain English. " +
    "Type **help** to see everything I can do, or tap an example on the right.",
};

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [dir, setDir] = useState<{ users: User[]; rooms: Room[]; holidays: Holiday[] }>({
    users: [],
    rooms: [],
    holidays: [],
  });
  const [busy, setBusy] = useState(false);
  const lastResp = useRef<CommandResponse | null>(null);

  const refresh = () => api.events().then(setEvents).catch(() => {});

  useEffect(() => {
    api.directory().then(setDir).catch(() => {});
    refresh();
  }, []);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const resp = await api.command(text);
      lastResp.current = resp;
      const extras: string[] = [];
      if (resp.notifications?.length) extras.push(resp.notifications.join("\n"));
      setMessages((m) => [
        ...m,
        { role: "assistant", text: resp.reply, slots: resp.slots, notifications: resp.notifications },
      ]);
      // any mutation refreshes the calendar
      if (resp.createdEvent || resp.updatedEvent || resp.cancelledEvent) refresh();
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `⚠️ Something went wrong: ${(e as Error).message}` },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">CoS</div>
          <div>
            <div className="title">Chief of Staff — Scheduling Assistant</div>
            <div className="subtitle">PoC · natural-language calendar control</div>
          </div>
        </div>
      </header>

      <div className="layout">
        <section className="col chat-col">
          <Chat messages={messages} busy={busy} onSend={send} />
        </section>

        <section className="col calendar-col">
          <Insights events={events} />
          <CalendarPanel events={events} dir={dir} />
        </section>

        <aside className="col side-col">
          <div className="panel">
            <h3>Try these</h3>
            <ul className="examples">
              {EXAMPLES.map((ex) => (
                <li key={ex}>
                  <button onClick={() => send(ex)} disabled={busy}>
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <h3>People</h3>
            <ul className="dir">
              {dir.users.map((u) => (
                <li key={u.id}>
                  <span className="name">{u.name}</span>
                  <span className="meta">{u.department}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <h3>Conference rooms</h3>
            <ul className="dir">
              {dir.rooms.map((r) => (
                <li key={r.id}>
                  <span className="name">{r.name}</span>
                  <span className="meta">cap {r.capacity}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <h3>Holidays (US / Home Office)</h3>
            <ul className="dir">
              {dir.holidays.map((h) => (
                <li key={h.date + h.name}>
                  <span className="name">{h.name}</span>
                  <span className={`tag ${h.region === "US" ? "us" : "ho"}`}>{h.region}</span>
                  <span className="meta">{h.date}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
