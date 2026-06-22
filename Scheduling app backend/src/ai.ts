// AI mode: use Claude to understand a free-form scheduling request and turn it
// into the same ParsedCommand the rule-based parser produces, so it flows through
// the unchanged assistant engine (conflicts, holidays, Postgres, Outlook).
//
// This is the LLM swap-in the README describes: better language understanding +
// conversation memory, same downstream execution. Entirely optional — without
// ANTHROPIC_API_KEY the app stays in rule-only mode and isAiConfigured() is false.
import Anthropic from "@anthropic-ai/sdk";
import { rooms, users } from "./store.js";
import { resolveAttendeeList, type Intent, type ParsedCommand } from "./nlp.js";
import type { MeetingPriority } from "./types.js";

const MODEL = "claude-opus-4-8";

const RAW_KEY = process.env.ANTHROPIC_API_KEY ?? "";
// Treat the common placeholder as "not set" so AI mode degrades gracefully
// instead of throwing a 401.
const PLACEHOLDERS = new Set(["", "your_api_key_here", "your-api-key", "sk-ant-xxxx"]);

export function isAiConfigured(): boolean {
  return !PLACEHOLDERS.has(RAW_KEY.trim());
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: RAW_KEY });
  return client;
}

const INTENTS: Intent[] = [
  "create", "availability", "reschedule", "cancel", "add_participant", "remove_participant",
  "review", "working_session", "focus_plan", "book_room", "delegate", "prep", "filler",
  "reprioritize", "set_priority", "help", "unknown",
];

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

// The single tool Claude must call — its input is a ParsedCommand in primitives.
const INTERPRET_TOOL: Anthropic.Tool = {
  name: "interpret",
  description: "Record the structured interpretation of the user's scheduling request.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: INTENTS, description: "The single best matching action." },
      title: { type: "string", description: "Meeting title, only if the user gave one. Do not invent." },
      agenda: { type: "string", description: "Agenda/description, only if the user gave one. Do not invent." },
      attendees: {
        type: "array",
        items: { type: "string" },
        description: "Each person named, as a full name or email from the directory. Include \"me\" if the user refers to themselves.",
      },
      start: { type: "string", description: "Primary date/time as local wall-clock ISO with no timezone, e.g. 2026-06-22T14:00:00." },
      to: { type: "string", description: "Target date/time for a reschedule (same ISO format)." },
      from: { type: "string", description: "Source/original date for a reschedule or cancel (same ISO format)." },
      durationMin: { type: "number", description: "Duration in minutes, if given." },
      room: { type: "string", description: "Conference-room city or name; empty string only if a room is requested without naming one." },
      reviewScope: { type: "string", enum: ["today", "tomorrow", "week", "month"], description: "Scope for a calendar review." },
      priority: { type: "string", enum: ["strategic", "operational", "low"], description: "Target priority for set_priority." },
      goalHours: { type: "number", description: "Weekly deep-work goal in hours for a focus plan." },
      reply: { type: "string", description: "For intent=unknown only: a short, friendly direct reply (e.g. to a greeting or off-topic question)." },
    },
    required: ["intent"],
  },
};

function systemPrompt(now: Date): string {
  const dir = users
    .map((u) => `- ${u.name}${u.id === "u_me" ? " (the user, 'me')" : ""} — ${u.department} — ${u.email}`)
    .join("\n");
  const roomList = rooms.map((r) => `- ${r.name} (${r.location})`).join("\n");
  return [
    "You convert a Chief of Staff's natural-language scheduling requests into one structured action by calling the `interpret` tool exactly once.",
    "",
    `Current date and time: ${now.toString()}. Resolve every relative date ("today", "tomorrow", "Friday", "next week") against this. Output all date/time fields as local wall-clock ISO WITHOUT a timezone, e.g. 2026-06-22T14:00:00.`,
    "",
    "Directory (resolve names to these people):",
    dir,
    "",
    "Conference rooms:",
    roomList,
    "",
    "Rules:",
    "- Choose the single best `intent`.",
    "- Put every person the user names into `attendees` (full name or email as listed). Include \"me\" when they say me/I/my.",
    "- NEVER fabricate a missing title or agenda — leave them out so the assistant can prompt for them.",
    "- Set `durationMin` when a length is stated; set `room` for room bookings or a meeting in a named room.",
    "- \"what do I have / show my calendar\" → intent=review with reviewScope.",
    "- \"mark/make X strategic|operational|low\" → intent=set_priority with priority.",
    "- \"plan focus/deep-work time\" → intent=focus_plan (goalHours if a number of hours is given).",
    "- Greetings, thanks, or non-scheduling chatter → intent=unknown with a short friendly `reply`.",
  ].join("\n");
}

interface InterpretArgs {
  intent?: string;
  title?: string;
  agenda?: string;
  attendees?: string[];
  start?: string;
  to?: string;
  from?: string;
  durationMin?: number;
  room?: string;
  reviewScope?: ParsedCommand["reviewScope"];
  priority?: string;
  goalHours?: number;
  reply?: string;
}

function toDate(iso?: string): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d;
}

// Parse one request with Claude. Returns the ParsedCommand to run through
// handle(), plus an optional directReply for non-scheduling chatter.
export async function aiParseCommand(
  text: string,
  history: ChatTurn[] = [],
  now = new Date(),
): Promise<{ command: ParsedCommand; directReply?: string }> {
  // Build the message list; the API requires it to start with a user turn.
  const msgs: Anthropic.MessageParam[] = history
    .filter((t) => t.text.trim())
    .map((t) => ({ role: t.role, content: t.text }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  msgs.push({ role: "user", content: text });

  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: "low" },
    system: systemPrompt(now),
    tools: [INTERPRET_TOOL],
    tool_choice: { type: "tool", name: "interpret" },
    messages: msgs,
  });

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const args = (toolUse?.input ?? {}) as InterpretArgs;

  const intent: Intent = INTENTS.includes(args.intent as Intent) ? (args.intent as Intent) : "unknown";
  const { attendees, ambiguous } = resolveAttendeeList(args.attendees ?? []);

  const command: ParsedCommand = {
    intent,
    raw: text,
    attendees,
    ambiguousNames: ambiguous,
    title: args.title?.trim() || undefined,
    agenda: args.agenda?.trim() || undefined,
    date: toDate(args.start),
    toDate: toDate(args.to),
    fromDate: toDate(args.from) ?? toDate(args.start),
    durationMin: typeof args.durationMin === "number" ? args.durationMin : undefined,
    roomQuery: args.room,
    reviewScope: args.reviewScope,
    priority: ["strategic", "operational", "low"].includes(args.priority ?? "")
      ? (args.priority as MeetingPriority)
      : undefined,
    goalHours: typeof args.goalHours === "number" ? args.goalHours : undefined,
  };

  const directReply = intent === "unknown" ? args.reply?.trim() || undefined : undefined;
  return { command, directReply };
}
