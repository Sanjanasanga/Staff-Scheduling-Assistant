// Calendar reasoning engine: availability search, conflict detection, holiday
// checks, room booking, and the lightweight "Additional Suggestions" analyses
// (prioritization, auto-delegate, prep builder, filler-meeting analyzer).
import { emails, events, files, holidays, rooms, users } from "./store.js";
import type { CalendarEvent, FreeSlot, Holiday, Room, User } from "./types.js";

const WORK_START_HOUR = 9; // 09:00
const WORK_END_HOUR = 17; // 17:00
const BUFFER_MINUTES = 15; // respected between back-to-back meetings

export const ms = (min: number) => min * 60 * 1000;

export function activeEvents(): CalendarEvent[] {
  return events.filter((e) => e.status === "confirmed");
}

export function findUser(id: string): User | undefined {
  return users.find((u) => u.id === id);
}

export function findRoom(id: string | null): Room | undefined {
  return id ? rooms.find((r) => r.id === id) : undefined;
}

// ---- conflicts -----------------------------------------------------------

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

// Events that clash with [start, end) for any of the given attendees.
export function attendeeConflicts(
  attendeeIds: string[],
  start: string,
  end: string,
  excludeEventId?: string,
): CalendarEvent[] {
  return activeEvents().filter(
    (e) =>
      e.id !== excludeEventId &&
      e.attendeeIds.some((a) => attendeeIds.includes(a)) &&
      overlaps(start, end, e.start, e.end),
  );
}

// Is a room already booked for [start, end)?
export function roomConflict(
  roomId: string,
  start: string,
  end: string,
  excludeEventId?: string,
): CalendarEvent | undefined {
  return activeEvents().find(
    (e) => e.id !== excludeEventId && e.roomId === roomId && overlaps(start, end, e.start, e.end),
  );
}

// ---- holidays ------------------------------------------------------------

export function holidaysOn(dateISO: string): Holiday[] {
  const day = dateISO.slice(0, 10);
  return holidays.filter((h) => h.date === day);
}

// ---- availability search -------------------------------------------------

// Walk forward day-by-day from `fromISO`, scanning working hours for the first
// windows of `durationMin` where every attendee is free. Skips weekends and
// holidays. Returns up to `limit` slots.
export function findFreeSlots(
  attendeeIds: string[],
  durationMin: number,
  fromISO: string,
  limit = 5,
  daysToScan = 14,
): FreeSlot[] {
  const slots: FreeSlot[] = [];
  const cursor = new Date(fromISO);
  cursor.setSeconds(0, 0);

  for (let day = 0; day < daysToScan && slots.length < limit; day++) {
    const dayDate = new Date(cursor);
    dayDate.setDate(dayDate.getDate() + day);
    const dow = dayDate.getDay();
    if (dow === 0 || dow === 6) continue; // weekend
    if (holidaysOn(dayDate.toISOString()).length) continue; // holiday

    // Probe in 15-min increments across the working window.
    const windowStart = new Date(dayDate);
    windowStart.setHours(WORK_START_HOUR, 0, 0, 0);
    const windowEnd = new Date(dayDate);
    windowEnd.setHours(WORK_END_HOUR, 0, 0, 0);

    let probe = new Date(Math.max(windowStart.getTime(), day === 0 ? cursor.getTime() : windowStart.getTime()));
    // round up to next 15 min
    probe.setMinutes(Math.ceil(probe.getMinutes() / 15) * 15, 0, 0);

    while (probe.getTime() + ms(durationMin) <= windowEnd.getTime() && slots.length < limit) {
      const slotStart = probe.toISOString();
      const slotEnd = new Date(probe.getTime() + ms(durationMin)).toISOString();
      if (attendeeConflicts(attendeeIds, slotStart, slotEnd).length === 0) {
        slots.push({ start: slotStart, end: slotEnd });
        // jump past this slot + buffer to find a distinct next option
        probe = new Date(probe.getTime() + ms(durationMin) + ms(BUFFER_MINUTES));
      } else {
        probe = new Date(probe.getTime() + ms(15));
      }
    }
  }
  return slots;
}

// Suggest alternative slots when a requested time is blocked.
export function suggestAlternatives(
  attendeeIds: string[],
  durationMin: number,
  desiredStartISO: string,
): FreeSlot[] {
  return findFreeSlots(attendeeIds, durationMin, desiredStartISO, 3);
}

// ---- buffer / focus checks ----------------------------------------------

// Returns adjacent events that leave less than BUFFER_MINUTES of breathing room
// around a proposed [start, end). Used to warn about back-to-back stacking.
export function bufferWarnings(attendeeIds: string[], start: string, end: string): string[] {
  const warnings: string[] = [];
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  for (const ev of activeEvents()) {
    if (!ev.attendeeIds.some((a) => attendeeIds.includes(a))) continue;
    const es = new Date(ev.start).getTime();
    const ee = new Date(ev.end).getTime();
    const gapBefore = (s - ee) / 60000;
    const gapAfter = (es - e) / 60000;
    if (gapBefore >= 0 && gapBefore < BUFFER_MINUTES) {
      warnings.push(`Only ${Math.round(gapBefore)} min after "${ev.title}" — under the ${BUFFER_MINUTES} min buffer.`);
    }
    if (gapAfter >= 0 && gapAfter < BUFFER_MINUTES) {
      warnings.push(`Only ${Math.round(gapAfter)} min before "${ev.title}" — under the ${BUFFER_MINUTES} min buffer.`);
    }
  }
  return warnings;
}

// ---- "additional suggestions" analyses -----------------------------------

// Filler-meeting analyzer: surface low-priority / short recurring meetings that
// are candidates to cut, merge, or delegate.
export function fillerAnalysis(organizerId: string): { event: CalendarEvent; reason: string; suggestion: string }[] {
  return activeEvents()
    .filter((e) => e.organizerId === organizerId && e.type === "meeting")
    .flatMap((e) => {
      const durationMin = (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000;
      if (e.priority === "low") {
        return [{ event: e, reason: "Flagged low priority.", suggestion: "Consider cancelling or delegating." }];
      }
      if (durationMin <= 30 && e.attendeeIds.length <= 2) {
        return [{ event: e, reason: "Very short with few attendees.", suggestion: "Consider merging into an existing sync or replacing with async update." }];
      }
      return [];
    });
}

// Auto-delegate: pick a plausible delegate (another attendee not the organizer)
// and draft a short handover note.
export function delegationSuggestion(event: CalendarEvent): { delegate: User | undefined; message: string } {
  const candidate = event.attendeeIds.map(findUser).find((u) => u && u.id !== event.organizerId);
  const when = new Date(event.start).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const message = candidate
    ? `Hi ${candidate.name.split(" ")[0]}, could you cover "${event.title}" on ${when}? Agenda: ${event.agenda || "(none provided)"} — please capture decisions and send me a quick recap. Thanks!`
    : `No suitable delegate found among attendees.`;
  return { delegate: candidate, message };
}

// Tokenize free text into lowercase keywords for relevance matching.
function keywords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}

// Pull recent emails + files relevant to an event, scored by attendee
// involvement and tag/keyword overlap with the title + agenda.
export function prepContext(event: CalendarEvent): { emails: typeof emails; files: typeof files } {
  const kw = keywords(`${event.title} ${event.agenda}`);
  const relevant = <T extends { owner?: string; from?: string; tags: string[]; date?: string }>(items: T[]) =>
    items
      .map((item) => {
        const person = (item.from ?? item.owner) as string | undefined;
        const tagHits = item.tags.filter((t) => kw.has(t)).length;
        const score = (person && event.attendeeIds.includes(person) ? 2 : 0) + tagHits;
        return { item, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || String(b.item.date ?? "").localeCompare(String(a.item.date ?? "")))
      .slice(0, 3)
      .map((s) => s.item);
  return { emails: relevant(emails), files: relevant(files) };
}

// Meeting prep builder: assemble a 1-page executive summary, pulling the most
// relevant recent emails and files from the store (mock Graph mail + file store).
export function prepSummary(event: CalendarEvent): string {
  const attendees = event.attendeeIds.map((id) => findUser(id)?.name ?? id).join(", ");
  const room = findRoom(event.roomId)?.name ?? "No room";
  const when = new Date(event.start).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const endTime = new Date(event.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const { emails: relEmails, files: relFiles } = prepContext(event);

  const lines = [
    `MEETING PREP — ${event.title}`,
    `When: ${when} – ${endTime}`,
    `Where: ${room}`,
    `Attendees: ${attendees}`,
    `Priority: ${event.priority}`,
    ``,
    `Agenda:`,
    `  ${event.agenda || "(no agenda provided — add talking points)"}`,
    ``,
    `Recent emails:`,
    ...(relEmails.length
      ? relEmails.map((m) => `  • [${m.date}] ${m.subject} — ${m.snippet} (from ${findUser(m.from)?.name ?? m.from})`)
      : [`  • (no recent related emails found)`]),
    ``,
    `Relevant files:`,
    ...(relFiles.length
      ? relFiles.map((f) => `  • ${f.name} (owner: ${findUser(f.owner)?.name ?? f.owner})`)
      : [`  • (no related files found)`]),
    ``,
    `Suggested prep:`,
    `  • Skim the threads above and note open questions.`,
    `  • Decide the 2–3 decisions you need out of this meeting.`,
  ];
  return lines.join("\n");
}
