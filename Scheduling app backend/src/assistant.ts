// Executes a ParsedCommand against the store, applies the business rules from
// the spec (minimum required fields, conflict detection + suggestions, holiday
// warnings, room booking, participant management), and returns a chat reply
// plus any structured payload the UI wants to render.
import { nanoid } from "nanoid";
import { events, rooms, users } from "./store.js";
import {
  attendeeConflicts,
  bufferWarnings,
  delegationSuggestion,
  fillerAnalysis,
  findRoom,
  findUser,
  findFreeSlots,
  holidaysOn,
  prepSummary,
  roomConflict,
  suggestAlternatives,
} from "./scheduler.js";
import type { ParsedCommand } from "./nlp.js";
import type { CalendarEvent, FreeSlot } from "./types.js";

export interface AssistantResponse {
  reply: string;
  // Outlook-style side effects, surfaced so the UI can echo them.
  notifications?: string[];
  createdEvent?: CalendarEvent;
  updatedEvent?: CalendarEvent;
  cancelledEvent?: CalendarEvent;
  slots?: FreeSlot[];
  events?: CalendarEvent[];
  needsClarification?: boolean;
}

const ME = "u_me";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

const now = () => new Date().toISOString();

function attendeeNames(ids: string[]): string {
  return ids.map((id) => findUser(id)?.name ?? id).join(", ");
}

// When attendees span time zones other than the organizer's, show the start
// time in each so the user sees what it looks like for global teams.
function timezoneLine(startISO: string, attendeeIds: string[]): string | null {
  const me = findUser(ME);
  const byZone = new Map<string, string[]>();
  for (const id of attendeeIds) {
    const u = findUser(id);
    if (!u || u.timezone === me?.timezone) continue;
    byZone.set(u.timezone, [...(byZone.get(u.timezone) ?? []), u.name.split(" ")[0]]);
  }
  if (!byZone.size) return null;
  const parts = [...byZone.entries()].map(([tz, names]) => {
    const local = new Date(startISO).toLocaleTimeString("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit",
    });
    const city = tz.split("/")[1]?.replace(/_/g, " ") ?? tz;
    return `${local} for ${names.join(", ")} (${city})`;
  });
  return `   🌍 Across time zones: ${parts.join(" · ")}`;
}

function notifyAttendees(event: CalendarEvent, verb: string): string[] {
  return event.attendeeIds
    .filter((id) => id !== event.organizerId)
    .map((id) => `📧 ${verb} sent to ${findUser(id)?.email ?? id}`);
}

const STOP = new Set([
  "the", "a", "an", "my", "meeting", "with", "to", "from", "on", "at", "for",
  "and", "of", "in", "move", "cancel", "delete", "reschedule", "add", "remove",
  "prep", "me", "i",
]);

// Match an existing event the user is referring to. Combines three signals —
// named attendees (excluding "me", who is on everything), an explicit date, and
// overlap between the command's words and the event's title — then intersects
// whichever signals are present. Falls back gracefully so a single strong
// signal (e.g. just the title) still resolves.
function matchEvents(cmd: ParsedCommand, ref?: Date): CalendarEvent[] {
  const active = events.filter((e) => e.status === "confirmed");
  const named = cmd.attendees.filter((a) => a.id !== ME);
  const cmdTokens = new Set(cmd.raw.toLowerCase().split(/[^a-z0-9łóąćęńśźż]+/i).filter(Boolean));

  // Title-token overlap score per event.
  const scored = active.map((e) => {
    const titleTokens = e.title
      .toLowerCase()
      .split(/[^a-z0-9łóąćęńśźż]+/i)
      .filter((t) => t.length > 2 && !STOP.has(t));
    const hits = titleTokens.filter((t) => cmdTokens.has(t)).length;
    return { e, hits };
  });
  const maxHits = Math.max(0, ...scored.map((s) => s.hits));
  const byTitle = maxHits > 0 ? scored.filter((s) => s.hits === maxHits).map((s) => s.e) : null;
  const byAttendee = named.length ? active.filter((e) => named.some((a) => e.attendeeIds.includes(a.id))) : null;
  const byDate = ref ? active.filter((e) => new Date(e.start).toDateString() === ref.toDateString()) : null;

  // Intersect available constraints; if that wipes everything out, relax by
  // dropping the date constraint, then the attendee constraint.
  const intersect = (sets: (CalendarEvent[] | null)[]) => {
    const present = sets.filter((s): s is CalendarEvent[] => s !== null);
    if (!present.length) return active;
    return present.reduce((acc, set) => acc.filter((e) => set.includes(e)));
  };

  let result = intersect([byTitle, byAttendee, byDate]);
  if (!result.length) result = intersect([byTitle, byAttendee]);
  if (!result.length) result = intersect([byTitle]);
  return result;
}

function resolveRoom(roomQuery?: string) {
  if (roomQuery === undefined) return { room: undefined as ReturnType<typeof findRoom>, requested: false };
  if (roomQuery === "") return { room: undefined, requested: true };
  const q = roomQuery.toLowerCase();
  const room = rooms.find((r) => r.name.toLowerCase().includes(q) || r.location.toLowerCase().includes(q));
  return { room, requested: true };
}

export function handle(cmd: ParsedCommand): AssistantResponse {
  // Ambiguous person reference — ask for a qualifier before doing anything.
  if (cmd.ambiguousNames.length) {
    const a = cmd.ambiguousNames[0];
    const opts = a.matches.map((m) => `${m.name} (${m.department}, ${m.email})`).join("  ·  ");
    return {
      reply: `There are multiple people named **${a.name}**. Which one?\n\n${opts}\n\nReply with the department or email to disambiguate.`,
      needsClarification: true,
    };
  }

  switch (cmd.intent) {
    case "help":
      return { reply: helpText() };

    case "create":
      return handleCreate(cmd);
    case "working_session":
      return handleWorkingSession(cmd);
    case "availability":
      return handleAvailability(cmd);
    case "reschedule":
      return handleReschedule(cmd);
    case "cancel":
      return handleCancel(cmd);
    case "add_participant":
      return handleAddParticipant(cmd);
    case "remove_participant":
      return handleRemoveParticipant(cmd);
    case "review":
      return handleReview(cmd);
    case "book_room":
      return handleBookRoom(cmd);
    case "delegate":
      return handleDelegate(cmd);
    case "prep":
      return handlePrep(cmd);
    case "filler":
      return handleFiller();
    case "set_priority":
      return handleSetPriority(cmd);
    case "reprioritize":
      return handleReprioritize(cmd);
    case "focus_plan":
      return handleFocusPlan(cmd);

    default:
      return {
        reply:
          "I didn't quite catch that. Try things like:\n" +
          "• \"Schedule a meeting with Anna Nowak on May 6 at 14:00\"\n" +
          "• \"Find a 60-minute window when Kasia, Tomek and I are free\"\n" +
          "• \"What do I have scheduled today?\"\n\nType **help** for the full list.",
      };
  }
}

// ---- create --------------------------------------------------------------

function handleCreate(cmd: ParsedCommand): AssistantResponse {
  // Minimum required fields: start date/time, title, agenda.
  const missing: string[] = [];
  if (!cmd.date) missing.push("a start date/time");
  if (!cmd.title) missing.push("a meeting title");
  if (!cmd.agenda) missing.push("a brief agenda/description");

  if (missing.length) {
    return {
      reply:
        `Before I can create this meeting I need ${missing.join(", ")}.\n\n` +
        `Minimum required fields: **start date/time**, **title**, **agenda**.\n` +
        `Example: \"Schedule 'Budget Review' with Anna on Jun 22 at 14:00, agenda: finalize Q3 numbers\".`,
      needsClarification: true,
    };
  }

  const durationMin = cmd.durationMin ?? 30;
  const start = cmd.date!;
  const end = new Date(start.getTime() + durationMin * 60000);
  const attendeeIds = unique([ME, ...cmd.attendees.map((a) => a.id)]);

  // Holiday warning (US + Home Office).
  const hols = holidaysOn(start.toISOString());

  // Conflict detection.
  const conflicts = attendeeConflicts(attendeeIds, start.toISOString(), end.toISOString());
  if (conflicts.length) {
    const alts = suggestAlternatives(attendeeIds, durationMin, start.toISOString());
    return {
      reply:
        `⚠️ Conflict: ${conflictText(conflicts)} overlaps ${fmt(start.toISOString())}.\n\n` +
        (alts.length
          ? `Here are the next open ${durationMin}-min windows for everyone:\n${alts.map((s, i) => `${i + 1}. ${fmt(s.start)}`).join("\n")}\n\nWant me to book one of these instead?`
          : `I couldn't find an open window in the next two weeks — try a different day.`),
      slots: alts,
      needsClarification: true,
    };
  }

  // Room (optional).
  const { room, requested } = resolveRoom(cmd.roomQuery);
  if (requested && cmd.roomQuery && !room) {
    return { reply: `I couldn't match "${cmd.roomQuery}" to a conference room. Available: ${rooms.map((r) => r.name).join(", ")}.`, needsClarification: true };
  }
  if (room) {
    const clash = roomConflict(room.id, start.toISOString(), end.toISOString());
    if (clash) {
      return { reply: `⚠️ ${room.name} is already booked for "${clash.title}" at that time. Pick another room or time.`, needsClarification: true };
    }
  }

  const event = persist({
    title: cmd.title!,
    agenda: cmd.agenda!,
    start: start.toISOString(),
    end: end.toISOString(),
    organizerId: ME,
    attendeeIds,
    roomId: room?.id ?? null,
    type: "meeting",
    priority: "operational",
  });

  const buffers = bufferWarnings(attendeeIds, event.start, event.end);
  const lines = [
    `✅ Created **${event.title}** for ${fmt(event.start)} – ${new Date(event.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`,
    `   Attendees: ${attendeeNames(attendeeIds)}.`,
    room ? `   Room: ${room.name}.` : `   No room booked.`,
  ];
  if (hols.length) lines.push(`   🎌 Heads up: ${holidayText(hols)} falls on this day.`);
  if (buffers.length) lines.push(`   ⏳ Buffer note: ${buffers[0]}`);
  const tz = timezoneLine(event.start, attendeeIds);
  if (tz) lines.push(tz);

  return {
    reply: lines.join("\n"),
    createdEvent: event,
    notifications: notifyAttendees(event, "Invite"),
  };
}

// ---- working session -----------------------------------------------------

function handleWorkingSession(cmd: ParsedCommand): AssistantResponse {
  if (!cmd.date) {
    return { reply: "When would you like the working session, and for how long? e.g. \"Block a 90-minute working session tomorrow at 13:00\".", needsClarification: true };
  }
  const durationMin = cmd.durationMin ?? 60;
  const start = cmd.date;
  const end = new Date(start.getTime() + durationMin * 60000);
  const conflicts = attendeeConflicts([ME], start.toISOString(), end.toISOString());
  if (conflicts.length) {
    const alts = suggestAlternatives([ME], durationMin, start.toISOString());
    return {
      reply: `⚠️ You already have ${conflictText(conflicts)} then. Free ${durationMin}-min focus blocks:\n${alts.map((s, i) => `${i + 1}. ${fmt(s.start)}`).join("\n")}`,
      slots: alts,
      needsClarification: true,
    };
  }
  const event = persist({
    title: cmd.title ?? "Working Session",
    agenda: "Focus time to complete tasks independently.",
    start: start.toISOString(),
    end: end.toISOString(),
    organizerId: ME,
    attendeeIds: [ME],
    roomId: null,
    type: "working-session",
    priority: "strategic",
  });
  return {
    reply: `✅ Blocked a ${durationMin}-min **working session** for ${fmt(event.start)}. I'll keep it as protected focus time.`,
    createdEvent: event,
  };
}

// ---- availability --------------------------------------------------------

function handleAvailability(cmd: ParsedCommand): AssistantResponse {
  const durationMin = cmd.durationMin ?? 30;
  const attendeeIds = unique([ME, ...cmd.attendees.map((a) => a.id)]);
  const from = cmd.date ?? new Date();
  const slots = findFreeSlots(attendeeIds, durationMin, from.toISOString(), 5);
  if (!slots.length) {
    return { reply: `No ${durationMin}-min window where ${attendeeNames(attendeeIds)} are all free in the next two weeks. Try a shorter duration or wider range.` };
  }
  return {
    reply:
      `Here are open ${durationMin}-min windows for **${attendeeNames(attendeeIds)}**:\n` +
      slots.map((s, i) => `${i + 1}. ${fmt(s.start)} – ${new Date(s.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`).join("\n") +
      `\n\nSay e.g. "book option 1 as 'Sync', agenda: ..." to schedule.`,
    slots,
  };
}

// ---- reschedule ----------------------------------------------------------

function handleReschedule(cmd: ParsedCommand): AssistantResponse {
  const matches = matchEvents(cmd, cmd.fromDate);
  if (!matches.length) return { reply: "I couldn't find a matching meeting to reschedule. Mention the person, title, or original day.", needsClarification: true };
  if (matches.length > 1) return { reply: disambiguateEvents(matches), needsClarification: true };
  if (!cmd.toDate) return { reply: "What day/time should I move it to? e.g. \"...to Monday at 11:00\".", needsClarification: true };

  const event = matches[0];
  const durationMin = (new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000;
  const newStart = cmd.toDate;
  const newEnd = new Date(newStart.getTime() + durationMin * 60000);

  const conflicts = attendeeConflicts(event.attendeeIds, newStart.toISOString(), newEnd.toISOString(), event.id);
  if (conflicts.length) {
    const alts = suggestAlternatives(event.attendeeIds, durationMin, newStart.toISOString());
    return {
      reply: `⚠️ ${conflictText(conflicts)} already occupies ${fmt(newStart.toISOString())}. Alternatives:\n${alts.map((s, i) => `${i + 1}. ${fmt(s.start)}`).join("\n")}`,
      slots: alts,
      needsClarification: true,
    };
  }
  const hols = holidaysOn(newStart.toISOString());
  event.start = newStart.toISOString();
  event.end = newEnd.toISOString();
  event.updatedAt = now();

  const lines = [`✅ Moved **${event.title}** to ${fmt(event.start)}.`];
  if (hols.length) lines.push(`   🎌 Note: ${holidayText(hols)} falls on the new day.`);
  const tz = timezoneLine(event.start, event.attendeeIds);
  if (tz) lines.push(tz);
  return { reply: lines.join("\n"), updatedEvent: event, notifications: notifyAttendees(event, "Update") };
}

// ---- cancel --------------------------------------------------------------

function handleCancel(cmd: ParsedCommand): AssistantResponse {
  const matches = matchEvents(cmd, cmd.fromDate ?? cmd.date);
  if (!matches.length) return { reply: "I couldn't find that meeting to cancel. Mention the title, person, or day.", needsClarification: true };
  if (matches.length > 1) return { reply: disambiguateEvents(matches), needsClarification: true };

  const event = matches[0];
  event.status = "cancelled";
  event.updatedAt = now();
  return {
    reply: `🗑️ Cancelled **${event.title}** (${fmt(event.start)}) and sent cancellation notices.`,
    cancelledEvent: event,
    notifications: notifyAttendees(event, "Cancellation"),
  };
}

// ---- participants --------------------------------------------------------

function handleAddParticipant(cmd: ParsedCommand): AssistantResponse {
  if (!cmd.attendees.length) return { reply: "Who should I add?", needsClarification: true };
  // exclude the added people from the event-matching attendee filter
  const matches = matchEvents({ ...cmd, attendees: [] }, cmd.date);
  if (!matches.length) return { reply: "Which meeting? Mention its title or day.", needsClarification: true };
  if (matches.length > 1) return { reply: disambiguateEvents(matches), needsClarification: true };

  const event = matches[0];
  const added = cmd.attendees.filter((a) => !event.attendeeIds.includes(a.id));
  event.attendeeIds = unique([...event.attendeeIds, ...added.map((a) => a.id)]);
  event.updatedAt = now();
  return {
    reply: added.length
      ? `✅ Added ${added.map((a) => a.name).join(", ")} to **${event.title}**.`
      : `Those people are already on **${event.title}**.`,
    updatedEvent: event,
    notifications: added.map((a) => `📧 Invite sent to ${a.email}`),
  };
}

function handleRemoveParticipant(cmd: ParsedCommand): AssistantResponse {
  if (!cmd.attendees.length) return { reply: "Who should I remove?", needsClarification: true };
  const matches = matchEvents({ ...cmd, attendees: [] }, cmd.date);
  if (!matches.length) return { reply: "Which meeting? Mention its title or day.", needsClarification: true };
  if (matches.length > 1) return { reply: disambiguateEvents(matches), needsClarification: true };

  const event = matches[0];
  const removed = cmd.attendees.filter((a) => event.attendeeIds.includes(a.id) && a.id !== ME);
  event.attendeeIds = event.attendeeIds.filter((id) => !removed.some((r) => r.id === id));
  event.updatedAt = now();
  return {
    reply: removed.length
      ? `✅ Removed ${removed.map((a) => a.name).join(", ")} from **${event.title}**.`
      : `Those people weren't on **${event.title}**.`,
    updatedEvent: event,
    notifications: removed.map((a) => `📧 Cancellation sent to ${a.email}`),
  };
}

// ---- review --------------------------------------------------------------

function handleReview(cmd: ParsedCommand): AssistantResponse {
  const ref = cmd.date ?? new Date();
  const active = events.filter((e) => e.status === "confirmed" && e.attendeeIds.includes(ME));
  let inScope: CalendarEvent[];
  let label: string;

  switch (cmd.reviewScope) {
    case "tomorrow": {
      const d = new Date(); d.setDate(d.getDate() + 1);
      inScope = active.filter((e) => new Date(e.start).toDateString() === d.toDateString());
      label = `tomorrow (${fmtDay(d.toISOString())})`;
      break;
    }
    case "week": {
      const start = new Date(); const end = new Date(); end.setDate(end.getDate() + 7);
      inScope = active.filter((e) => new Date(e.start) >= start && new Date(e.start) <= end);
      label = "the next 7 days";
      break;
    }
    case "month": {
      const m = ref.getMonth(); const y = ref.getFullYear();
      inScope = active.filter((e) => { const d = new Date(e.start); return d.getMonth() === m && d.getFullYear() === y; });
      label = ref.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      break;
    }
    default: {
      const d = new Date();
      inScope = active.filter((e) => new Date(e.start).toDateString() === d.toDateString());
      label = `today (${fmtDay(d.toISOString())})`;
    }
  }

  inScope.sort((a, b) => +new Date(a.start) - +new Date(b.start));
  if (!inScope.length) return { reply: `You have nothing scheduled for ${label}. 🎉`, events: [] };

  const lines = inScope.map((e) => {
    const room = findRoom(e.roomId);
    return `• ${fmt(e.start)} — **${e.title}** [${e.priority}]${room ? ` @ ${room.name}` : ""} (${attendeeNames(e.attendeeIds)})`;
  });
  return { reply: `Your schedule for ${label}:\n${lines.join("\n")}`, events: inScope };
}

// ---- room booking --------------------------------------------------------

function handleBookRoom(cmd: ParsedCommand): AssistantResponse {
  const { room } = resolveRoom(cmd.roomQuery);
  if (!room) {
    return {
      reply: `Which conference room?\n${rooms.map((r) => `• ${r.name} (cap ${r.capacity})`).join("\n")}`,
      needsClarification: true,
    };
  }
  if (!cmd.date) return { reply: `When should I book ${room.name}?`, needsClarification: true };

  const durationMin = cmd.durationMin ?? 60;
  const start = cmd.date;
  const end = new Date(start.getTime() + durationMin * 60000);
  const clash = roomConflict(room.id, start.toISOString(), end.toISOString());
  if (clash) {
    return { reply: `⚠️ ${room.name} is taken by "${clash.title}" at ${fmt(start.toISOString())}. Try another time or room.`, needsClarification: true };
  }
  const event = persist({
    title: cmd.title ?? `Room hold — ${room.name}`,
    agenda: "Room reservation.",
    start: start.toISOString(),
    end: end.toISOString(),
    organizerId: ME,
    attendeeIds: [ME],
    roomId: room.id,
    type: "meeting",
    priority: "operational",
  });
  return { reply: `✅ Booked **${room.name}** for ${fmt(event.start)} (${durationMin} min) on the shared room calendar.`, createdEvent: event };
}

// ---- additional suggestions ---------------------------------------------

function handleDelegate(cmd: ParsedCommand): AssistantResponse {
  const matches = matchEvents(cmd, cmd.fromDate);
  if (!matches.length) return { reply: "Which meeting should I find a delegate for? Mention its title or day.", needsClarification: true };
  const event = matches[0];
  const { delegate, message } = delegationSuggestion(event);
  if (!delegate) return { reply: `No suitable delegate among the attendees of "${event.title}".` };
  return { reply: `🤝 You could hand off **${event.title}** to **${delegate.name}**. Draft handover:\n\n"${message}"` };
}

function handlePrep(cmd: ParsedCommand): AssistantResponse {
  const matches = matchEvents(cmd, cmd.fromDate);
  if (!matches.length) return { reply: "Which meeting do you want prep for? Mention its title or day.", needsClarification: true };
  const event = matches[0];
  return { reply: `📋 ${prepSummary(event)}` };
}

function handleFiller(): AssistantResponse {
  const flagged = fillerAnalysis(ME);
  if (!flagged.length) return { reply: "No obvious filler meetings on your calendar right now. 👍" };
  const lines = flagged.map((f) => `• **${f.event.title}** (${fmt(f.event.start)}) — ${f.reason} ${f.suggestion}`);
  return { reply: `🔍 Potential low-impact meetings:\n${lines.join("\n")}`, events: flagged.map((f) => f.event) };
}

// ---- prioritization & focus planning -------------------------------------

const PRIORITY_RANK: Record<string, number> = { strategic: 0, operational: 1, low: 2 };

function handleSetPriority(cmd: ParsedCommand): AssistantResponse {
  if (!cmd.priority) {
    return { reply: "What priority should it be — **strategic**, **operational**, or **low**?", needsClarification: true };
  }
  const matches = matchEvents(cmd, cmd.fromDate);
  if (!matches.length) return { reply: "Which meeting should I reprioritize? Mention its title or day.", needsClarification: true };
  if (matches.length > 1) return { reply: disambiguateEvents(matches), needsClarification: true };

  const event = matches[0];
  const prev = event.priority;
  if (prev === cmd.priority) return { reply: `**${event.title}** is already marked **${cmd.priority}**.` };
  event.priority = cmd.priority;
  event.updatedAt = now();
  return { reply: `✅ Reprioritized **${event.title}** to **${cmd.priority}** (was ${prev}).`, updatedEvent: event };
}

function handleReprioritize(cmd: ParsedCommand): AssistantResponse {
  const horizon = new Date();
  const end = new Date();
  if (cmd.reviewScope === "today" || cmd.reviewScope === "tomorrow") end.setDate(end.getDate() + 1);
  else if (cmd.reviewScope === "month") end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + 7);

  const upcoming = events.filter(
    (e) => e.status === "confirmed" && e.attendeeIds.includes(ME) && new Date(e.end) >= horizon && new Date(e.start) <= end,
  );
  if (!upcoming.length) return { reply: "Nothing on your calendar in that window to reprioritize.", events: [] };

  upcoming.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || +new Date(a.start) - +new Date(b.start));
  const lines = upcoming.map((e) => `• [${e.priority.toUpperCase()}] ${fmt(e.start)} — **${e.title}**`);
  const low = upcoming.filter((e) => e.priority === "low");
  const tail = low.length
    ? `\n\n💡 ${low.length} low-priority item(s) — candidates to cut, delegate, or make async. Ask "which meetings can I cut?".`
    : `\n\n💡 No low-priority clutter — your strategic time is well protected.`;
  return { reply: `Calendar reprioritized (strategic → low):\n${lines.join("\n")}${tail}`, events: upcoming };
}

function handleFocusPlan(cmd: ParsedCommand): AssistantResponse {
  const goalHours = cmd.goalHours ?? 5;
  const blockMin = cmd.durationMin ?? 90;
  const target = Math.max(1, Math.ceil((goalHours * 60) / blockMin));
  const slots = findFreeSlots([ME], blockMin, new Date().toISOString(), target, 7);
  if (!slots.length) {
    return { reply: `Your week is fully booked — no ${blockMin}-min focus blocks free. Cut a low-priority meeting first ("which meetings can I cut?").` };
  }
  const plannedHours = Math.round(((slots.length * blockMin) / 60) * 10) / 10;
  const lines = slots.map(
    (s, i) => `${i + 1}. ${fmt(s.start)} – ${new Date(s.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`,
  );
  return {
    reply:
      `🧠 Deep-work plan — ${plannedHours}h of focus toward your ${goalHours}h goal (${blockMin}-min blocks):\n` +
      lines.join("\n") +
      `\n\nSay e.g. "Block a ${blockMin}-minute working session tomorrow at 14:00" to lock one in as protected time.`,
    slots,
  };
}

// ---- helpers -------------------------------------------------------------

function persist(data: Omit<CalendarEvent, "id" | "status" | "createdAt" | "updatedAt">): CalendarEvent {
  const event: CalendarEvent = { ...data, id: nanoid(8), status: "confirmed", createdAt: now(), updatedAt: now() };
  events.push(event);
  return event;
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function conflictText(list: CalendarEvent[]): string {
  return list.map((c) => `"${c.title}" (${fmt(c.start)})`).join(", ");
}

function holidayText(list: { name: string; region: string }[]): string {
  return list.map((h) => `${h.name} [${h.region}]`).join(", ");
}

function disambiguateEvents(list: CalendarEvent[]): string {
  return (
    "I found more than one matching meeting — which one?\n" +
    list.map((e, i) => `${i + 1}. **${e.title}** — ${fmt(e.start)} (${attendeeNames(e.attendeeIds)})`).join("\n")
  );
}

function helpText(): string {
  return [
    "I'm your scheduling assistant. I can:",
    "• **Create** — \"Schedule 'Budget Review' with Anna Nowak on May 6 at 14:00, agenda: Q3 numbers\"",
    "• **Check availability** — \"Find a 60-minute window when Kasia, Tomek and I are free\"",
    "• **Reschedule** — \"Move my meeting with Paweł from Friday to Monday at 11:00\"",
    "• **Cancel** — \"Cancel the HR meeting tomorrow at 9:00\"",
    "• **Add/remove people** — \"Add Joanna Kowalska to the Ops Sync\"",
    "• **Review** — \"What do I have scheduled today?\" / \"Show all my meetings this week\"",
    "• **Working session** — \"Block a 90-minute working session tomorrow at 13:00\"",
    "• **Focus plan** — \"Plan 6 hours of focus time this week\"",
    "• **Book a room** — \"Book CONF NOR Port of Miami tomorrow at 10:00 for 60 minutes\"",
    "• **Prioritize** — \"Mark the Finance Review as strategic\" / \"Reprioritize my calendar\"",
    "• **Delegate / Prep / Filler analysis** — \"Who can cover the Ops Sync?\", \"Prep me for the Finance Review\", \"Which meetings can I cut?\"",
    "",
    "I'll flag scheduling conflicts, holidays (US & Home Office), buffer/focus time, and cross-time-zone hours, and ask for any missing required fields.",
  ].join("\n");
}

export { users, rooms };
