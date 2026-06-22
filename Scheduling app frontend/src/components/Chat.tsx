import { useEffect, useRef, useState } from "react";
import type { FreeSlot } from "../api";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  slots?: FreeSlot[];
  notifications?: string[];
}

// Minimal markdown: **bold** and newlines. Avoids pulling in a markdown dep.
function render(text: string) {
  return text.split("\n").map((line, i) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith("**") && p.endsWith("**") ? <strong key={j}>{p.slice(2, -2)}</strong> : <span key={j}>{p}</span>,
    );
    return (
      <div key={i} className="line">
        {parts}
      </div>
    );
  });
}

export default function Chat({
  messages,
  busy,
  onSend,
}: {
  messages: ChatMessage[];
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSend(input);
    setInput("");
  };

  // "Jun 23, 9:00 AM" → "Jun 23 at 9:00 AM"
  const fmtSlot = (iso: string) =>
    new Date(iso)
      .toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      .replace(",", " at");

  // Clicking a suggested slot drafts a ready-to-edit booking in the composer.
  const draftFromSlot = (start: string) => {
    setInput(`Schedule 'Meeting' on ${fmtSlot(start)}, agenda: `);
    inputRef.current?.focus();
  };

  return (
    <div className="chat">
      <div className="transcript">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="msg-col">
              <div className="bubble">{render(m.text)}</div>
              {m.slots && m.slots.length > 0 && (
                <div className="slots">
                  {m.slots.map((s, j) => (
                    <button
                      key={j}
                      type="button"
                      className="slot-chip"
                      onClick={() => draftFromSlot(s.start)}
                      disabled={busy}
                      title="Draft a booking at this time"
                    >
                      {fmtSlot(s.start)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            <div className="bubble typing">
              <span /> <span /> <span />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          ref={inputRef}
          autoFocus
          placeholder='e.g. "Schedule a meeting with Anna on May 6 at 14:00, agenda: planning"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
