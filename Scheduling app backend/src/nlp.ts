// Lightweight rule-based natural-language parser for the PoC. Turns a command
// like "Schedule a meeting with Anna Nowak on May 6 at 14:00" into a structured
// intent + entities. Deliberately dependency-free and explainable — no LLM call.
import { users } from "./store.js";
import type { MeetingPriority, User } from "./types.js";

export type Intent =
  | "create"
  | "availability"
  | "reschedule"
  | "cancel"
  | "add_participant"
  | "remove_participant"
  | "review"
  | "working_session"
  | "focus_plan"
  | "book_room"
  | "delegate"
  | "prep"
  | "filler"
  | "reprioritize"
  | "set_priority"
  | "help"
  | "unknown";

export interface ParsedCommand {
  intent: Intent;
  raw: string;
  title?: string;
  agenda?: string;
  attendees: User[];
  ambiguousNames: { name: string; matches: User[] }[];
  date?: Date; // primary date/time
  toDate?: Date; // target date/time for reschedule
  fromDate?: Date; // source date for reschedule / cancel matching
  durationMin?: number;
  roomQuery?: string;
  reviewScope?: "today" | "tomorrow" | "week" | "month";
  priority?: MeetingPriority; // target priority for set_priority
  goalHours?: number; // weekly deep-work goal for focus_plan
  withBuffer?: boolean; // auto-insert buffers around a created meeting
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
// 3-letter abbreviations, index-aligned with MONTHS. Used so "Jun 22" / "Dec 25"
// resolve correctly, not just full names.
const MONTH_ABBR = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Resolve a month token (full name, 3-letter abbrev, or "sept") to its index, or -1.
function monthIndex(token: string): number {
  const t = token.toLowerCase().replace(/\.$/, "");
  const full = MONTHS.indexOf(t);
  if (full >= 0) return full;
  return MONTH_ABBR.indexOf(t.slice(0, 3));
}

const deaccent = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ---- user resolution -----------------------------------------------------

// Find every directory user explicitly named in the text. Records ambiguous
// names (e.g. two "John Smith"s) unless disambiguated by a "(Team X)" or
// department/email qualifier.
function resolveAttendees(text: string): { attendees: User[]; ambiguous: { name: string; matches: User[] }[] } {
  const lower = deaccent(text);
  const attendees = new Map<string, User>();
  const ambiguous: { name: string; matches: User[] }[] = [];

  // Group directory users by full name to detect duplicates.
  const byName = new Map<string, User[]>();
  for (const u of users) {
    const key = deaccent(u.name);
    byName.set(key, [...(byName.get(key) ?? []), u]);
  }

  // "me"/"I" → the current user (u_me).
  if (/\b(me|i|my|myself)\b/.test(lower)) {
    const me = users.find((u) => u.id === "u_me");
    if (me) attendees.set(me.id, me);
  }

  for (const u of users) {
    if (u.id === "u_me") continue;
    const full = deaccent(u.name);
    const first = full.split(" ")[0];
    const matchesFull = lower.includes(full);
    const matchesFirst = new RegExp(`\\b${first}\\b`).test(lower);
    if (!matchesFull && !matchesFirst) continue;

    const sameName = byName.get(full) ?? [u];
    if (sameName.length > 1) {
      // Try to disambiguate by department/email qualifier appearing in text.
      const picked = sameName.filter(
        (cand) =>
          lower.includes(deaccent(cand.department)) ||
          lower.includes(cand.email.toLowerCase()),
      );
      if (picked.length === 1) {
        attendees.set(picked[0].id, picked[0]);
      } else if (!ambiguous.some((a) => a.name === u.name)) {
        ambiguous.push({ name: u.name, matches: sameName });
      }
    } else {
      attendees.set(u.id, u);
    }
  }

  return { attendees: [...attendees.values()], ambiguous };
}

// Resolve an explicit list of person references (names / first names / emails /
// "me") to directory users. Used by the AI parser, which hands us the people it
// extracted. Mirrors the rule-based ambiguity behaviour: a bare duplicate name
// (e.g. "John Smith") with no department/email qualifier is reported ambiguous
// so the assistant asks which one.
export function resolveAttendeeList(
  refs: string[],
): { attendees: User[]; ambiguous: { name: string; matches: User[] }[] } {
  const attendees = new Map<string, User>();
  const ambiguous: { name: string; matches: User[] }[] = [];

  for (const raw of refs) {
    const ref = deaccent(raw.trim());
    if (!ref) continue;

    if (/^(me|i|my|myself)$/.test(ref) || ref.includes("chief of staff")) {
      const me = users.find((u) => u.id === "u_me");
      if (me) attendees.set(me.id, me);
      continue;
    }

    const byEmail = users.find((u) => u.email.toLowerCase() === ref);
    if (byEmail) {
      attendees.set(byEmail.id, byEmail);
      continue;
    }

    let matches = users.filter((u) => u.id !== "u_me" && deaccent(u.name) === ref);
    if (!matches.length) {
      matches = users.filter(
        (u) => u.id !== "u_me" && (deaccent(u.name).split(" ")[0] === ref || deaccent(u.name).includes(ref)),
      );
    }
    // Disambiguate a duplicate name by a department/email qualifier inside the ref.
    if (matches.length > 1) {
      const picked = matches.filter(
        (u) => ref.includes(deaccent(u.department)) || ref.includes(u.email.toLowerCase()),
      );
      if (picked.length === 1) matches = picked;
    }

    if (matches.length === 1) {
      attendees.set(matches[0].id, matches[0]);
    } else if (matches.length > 1 && !ambiguous.some((a) => a.name === matches[0].name)) {
      ambiguous.push({ name: matches[0].name, matches });
    }
  }

  return { attendees: [...attendees.values()], ambiguous };
}

// ---- date / time parsing -------------------------------------------------

function parseTimeInto(d: Date, text: string): boolean {
  // 14:00 / 9:00 / 2pm / 2:30 pm / 11
  const hm = text.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  const hAmPm = text.match(/\bat\s+(\d{1,2})\s*(am|pm)\b/i);
  if (hm) {
    let h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    const ap = hm[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    d.setHours(h, m, 0, 0);
    return true;
  }
  if (hAmPm) {
    let h = parseInt(hAmPm[1], 10);
    const ap = hAmPm[2].toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    d.setHours(h, 0, 0, 0);
    return true;
  }
  return false;
}

// Parse the first date reference found in `text`. `now` is the reference point.
function parseDate(text: string, now: Date): Date | undefined {
  const lower = text.toLowerCase();

  // explicit "Month Day" e.g. "may 6", "june 22", "Jun 22", "Dec 25"
  const md = lower.match(
    new RegExp(`\\b(${[...MONTHS, ...MONTH_ABBR].join("|")})\\.?\\s+(\\d{1,2})\\b`),
  );
  if (md) {
    const month = monthIndex(md[1]);
    const day = parseInt(md[2], 10);
    let year = now.getFullYear();
    const candidate = new Date(year, month, day, 9, 0, 0, 0);
    if (candidate.getTime() < now.getTime() - 86400000) candidate.setFullYear(year + 1);
    parseTimeInto(candidate, text);
    return candidate;
  }

  // "tomorrow" / "today"
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    parseTimeInto(d, text);
    return d;
  }
  if (/\btoday\b/.test(lower)) {
    const d = new Date(now);
    d.setHours(9, 0, 0, 0);
    parseTimeInto(d, text);
    return d;
  }

  // weekday name → next occurrence
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(lower)) {
      const d = new Date(now);
      const delta = (i - d.getDay() + 7) % 7 || 7; // always a future weekday
      d.setDate(d.getDate() + delta);
      d.setHours(9, 0, 0, 0);
      parseTimeInto(d, text);
      return d;
    }
  }

  // bare time today/next ("at 14:00")
  if (/\bat\s+\d/.test(lower)) {
    const d = new Date(now);
    if (parseTimeInto(d, text)) {
      if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
      return d;
    }
  }
  return undefined;
}

function parseDuration(text: string): number | undefined {
  const m = text.match(/(\d+)\s*-?\s*(minute|minutes|min|mins)\b/i);
  if (m) return parseInt(m[1], 10);
  const h = text.match(/(\d+(?:\.\d+)?)\s*-?\s*(hour|hours|hr|hrs)\b/i);
  if (h) return Math.round(parseFloat(h[1]) * 60);
  return undefined;
}

// Weekly deep-work goal, e.g. "5 hours of focus time" → 5.
function parseGoalHours(text: string): number | undefined {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(hour|hours|hr|hrs)\b/i);
  return m ? parseFloat(m[1]) : undefined;
}

// Target priority for set_priority, e.g. "...as strategic".
function parsePriority(text: string): MeetingPriority | undefined {
  const m = text.toLowerCase().match(/\b(strategic|operational|low)\b/);
  return m ? (m[1] as MeetingPriority) : undefined;
}

function parseTitle(text: string): string | undefined {
  // "...meeting titled X" or quoted title
  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/);
  if (quoted) return quoted[1].trim();
  const titled = text.match(/\b(?:titled|called|title)\s+(.+?)(?:\s+(?:on|at|with|for)\b|$)/i);
  if (titled) return titled[1].trim();
  return undefined;
}

function parseAgenda(text: string): string | undefined {
  const m = text.match(/\b(?:agenda|about|re|regarding|to discuss|description)[:\s]+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

function parseRoom(text: string): string | undefined {
  const lower = text.toLowerCase();
  const m = lower.match(/\b(?:room|conf(?:erence)?(?:\s+room)?|port of)\b/);
  if (!m) return undefined;
  // Prefer an explicit port/city name — this is the unambiguous signal.
  const city = text.match(/\b(vancouver|virginia|miami|los angeles|new york)\b/i);
  if (city) return city[1];
  return ""; // room requested but unspecified
}

// ---- intent detection ----------------------------------------------------

export function parseCommand(raw: string, now = new Date()): ParsedCommand {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const { attendees, ambiguous } = resolveAttendees(text);
  const duration = parseDuration(text);

  const base: ParsedCommand = {
    intent: "unknown",
    raw,
    attendees,
    ambiguousNames: ambiguous,
    durationMin: duration,
  };

  // help
  if (/\b(help|what can you do|commands)\b/.test(lower) && !/meeting|schedule/.test(lower)) {
    return { ...base, intent: "help" };
  }

  // reprioritize the whole calendar — checked before review/set_priority so
  // "reprioritize my calendar" isn't swallowed by the review phrasing.
  if (/\b(re-?prioriti[sz]e)\b/.test(lower) || /\bprioriti[sz]e my\b/.test(lower)) {
    let scope: ParsedCommand["reviewScope"] = "week";
    if (/\btoday\b/.test(lower)) scope = "today";
    else if (/\btomorrow\b/.test(lower)) scope = "tomorrow";
    else if (/\bmonth\b/.test(lower)) scope = "month";
    return { ...base, intent: "reprioritize", reviewScope: scope };
  }

  // set a single meeting's priority — needs a priority word + a verb/qualifier
  // so it doesn't fire on "set up a meeting".
  const targetPriority = parsePriority(text);
  if (
    targetPriority &&
    /\b(mark|set|make|flag|tag|classif|treat|prioriti[sz]e|change)\b/.test(lower) &&
    /\b(as|to|priority|importance)\b/.test(lower)
  ) {
    return { ...base, intent: "set_priority", priority: targetPriority, title: parseTitle(text), fromDate: parseDate(text, now) };
  }

  // review calendar — phrasing must be specifically about *viewing* a schedule,
  // not just any sentence containing the word "review" (e.g. a meeting titled
  // "Budget Review"). Scheduling verbs short-circuit this branch entirely.
  const reviewPhrasing =
    /\bwhat(?:'s| is| do i have)\b.*\b(scheduled|on|meeting|calendar|today|tomorrow|week|month)\b/.test(lower) ||
    /\b(show|list|review|pull up)\b.*\b(my )?(meetings?|calendar|schedule|agenda|day|week|month)\b/.test(lower) ||
    /\bmy (meetings?|calendar|schedule|agenda)\b/.test(lower);
  if (reviewPhrasing && !/\b(schedule|set up|create|arrange|organi[sz]e|plan|book|reschedule|move|cancel|delete|add|remove)\b/.test(lower)) {
    let scope: ParsedCommand["reviewScope"] = "today";
    if (/\btomorrow\b/.test(lower)) scope = "tomorrow";
    else if (/\bweek\b/.test(lower)) scope = "week";
    else if (/\bmonth\b|\bin (january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(lower)) scope = "month";
    const monthDate = parseDate(text, now);
    return { ...base, intent: "review", reviewScope: scope, date: monthDate };
  }

  // filler analysis
  if (/\b(filler|low[- ]?impact|repetitive|which meetings (can|should) i (cut|drop|cancel))\b/.test(lower)) {
    return { ...base, intent: "filler" };
  }

  // prep builder
  if (/\b(prep|prepare|brief|summary|prep[- ]?note)\b/.test(lower)) {
    return { ...base, intent: "prep", fromDate: parseDate(text, now), title: parseTitle(text) };
  }

  // delegate
  if (/\b(delegate|hand ?off|hand ?over|cover|who (can|could|should) (cover|take|handle|attend))\b/.test(lower)) {
    return { ...base, intent: "delegate", fromDate: parseDate(text, now), title: parseTitle(text) };
  }

  // availability
  if (/\b(free|availab|window|find( me)? a (slot|time)|when (are|is)|open slot)\b/.test(lower)) {
    return { ...base, intent: "availability", durationMin: duration ?? 30, date: parseDate(text, now) ?? now };
  }

  // reschedule / move
  if (/\b(reschedule|move|shift|push|change.*to)\b/.test(lower)) {
    // "from Friday to Monday at 11:00" — split on " to "
    const parts = lower.split(/\bto\b/);
    const fromDate = parseDate(parts[0] ?? text, now);
    // parse the target from the portion after the last "to"
    const toPortion = text.slice(lower.lastIndexOf(" to ") + 4);
    const toDate = parseDate(toPortion, now) ?? parseDate(text, now);
    return { ...base, intent: "reschedule", fromDate, toDate, title: parseTitle(text) };
  }

  // cancel
  if (/\b(cancel|delete|remove the meeting|drop the meeting)\b/.test(lower)) {
    return { ...base, intent: "cancel", date: parseDate(text, now), fromDate: parseDate(text, now), title: parseTitle(text) };
  }

  // manage participants
  if (/\b(add)\b/.test(lower) && /\b(to the|to my|to)\b.*\b(meeting|sync|session|call|review)\b/.test(lower)) {
    return { ...base, intent: "add_participant", date: parseDate(text, now), title: parseTitle(text) };
  }
  if (/\b(remove|drop|take off)\b/.test(lower) && /\b(from the|from my|from)\b.*\b(meeting|sync|session|call|review)\b/.test(lower)) {
    return { ...base, intent: "remove_participant", date: parseDate(text, now), title: parseTitle(text) };
  }

  // focus plan — a *planning* request for deep-work blocks across the week,
  // distinct from blocking one explicit session ("...at 14:00"). Must come
  // before working_session so "plan my focus time this week" isn't treated as a
  // single block missing a time.
  if (
    /\b(focus|deep[- ]?work)\b/.test(lower) &&
    /\b(plan|protect|reserve|map|spread|throughout|each day|daily|this week|next week|goal|hours?)\b/.test(lower) &&
    !/\bat\s+\d/.test(lower)
  ) {
    // "6 hours" is the weekly goal; only an explicit minutes phrase
    // ("90-minute blocks") sets the per-block size.
    const blockMin = text.match(/(\d+)\s*-?\s*(minute|minutes|min|mins)\b/i);
    return {
      ...base,
      intent: "focus_plan",
      goalHours: parseGoalHours(text),
      durationMin: blockMin ? parseInt(blockMin[1], 10) : undefined,
    };
  }

  // working session
  if (/\b(working session|focus (time|block|session)|deep work|block (time|focus)|heads[- ]?down)\b/.test(lower)) {
    return { ...base, intent: "working_session", date: parseDate(text, now), durationMin: duration ?? 60, title: parseTitle(text) ?? "Working Session" };
  }

  // book a room (room-only, no clear meeting verb)
  const roomQuery = parseRoom(text);
  if (roomQuery !== undefined && /\bbook\b/.test(lower) && !/\bmeeting with\b/.test(lower)) {
    return { ...base, intent: "book_room", roomQuery, date: parseDate(text, now), durationMin: duration ?? 60, title: parseTitle(text) };
  }

  // create meeting (default scheduling verb)
  if (/\b(schedule|set up|create|book|arrange|organi[sz]e|plan)\b/.test(lower)) {
    return {
      ...base,
      intent: "create",
      title: parseTitle(text),
      agenda: parseAgenda(text),
      date: parseDate(text, now),
      durationMin: duration ?? 30,
      roomQuery,
    };
  }

  return base;
}
