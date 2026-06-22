// In-memory working set, backed by Postgres.
//
// The reasoning engine (scheduler.ts / assistant.ts) is synchronous and reads
// these arrays many times per command, so rather than make every helper async
// we hydrate the arrays from Postgres once at boot and write event mutations
// back through to the database. Postgres is the durable source of truth; these
// arrays are the request-time cache that survives restarts via hydrate().
import { pool } from "./db.js";
import type { CalendarEvent, EmailMsg, FileDoc, Holiday, Room, User } from "./types.js";

export const users: User[] = [];
export const rooms: Room[] = [];
export const holidays: Holiday[] = [];
export const emails: EmailMsg[] = [];
export const files: FileDoc[] = [];
export const events: CalendarEvent[] = [];

function replace<T>(target: T[], rows: T[]): void {
  target.length = 0;
  target.push(...rows);
}

// Load all tables from Postgres into the in-memory arrays. Call once at startup
// before the server begins handling requests.
export async function hydrate(): Promise<void> {
  const [u, r, h, em, fi, ev] = await Promise.all([
    pool.query(`SELECT id, name, email, department, timezone FROM users ORDER BY id`),
    pool.query(`SELECT id, name, capacity, location FROM rooms ORDER BY id`),
    pool.query(`SELECT to_char(date, 'YYYY-MM-DD') AS date, name, region FROM holidays ORDER BY date`),
    pool.query(`SELECT from_id, subject, snippet, to_char(date, 'YYYY-MM-DD') AS date, tags FROM emails ORDER BY date DESC`),
    pool.query(`SELECT name, owner_id, tags FROM files ORDER BY name`),
    pool.query(`SELECT * FROM events ORDER BY start_ts`),
  ]);

  replace(users, u.rows as User[]);
  replace(rooms, r.rows.map((row) => ({ ...row, capacity: Number(row.capacity) })) as Room[]);
  replace(holidays, h.rows as Holiday[]);
  replace(emails, em.rows.map((row) => ({ from: row.from_id, subject: row.subject, snippet: row.snippet, date: row.date, tags: row.tags })) as EmailMsg[]);
  replace(files, fi.rows.map((row) => ({ name: row.name, owner: row.owner_id, tags: row.tags })) as FileDoc[]);
  replace(events, ev.rows.map(rowToEvent));
}

function rowToEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    id: row.id as string,
    title: row.title as string,
    agenda: row.agenda as string,
    start: (row.start_ts as Date).toISOString(),
    end: (row.end_ts as Date).toISOString(),
    organizerId: row.organizer_id as string,
    attendeeIds: row.attendee_ids as string[],
    roomId: (row.room_id as string | null) ?? null,
    type: row.type as CalendarEvent["type"],
    status: row.status as CalendarEvent["status"],
    priority: row.priority as CalendarEvent["priority"],
    outlookEventId: (row.outlook_event_id as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

// Write the current in-memory events back to Postgres (upsert by id). Called
// after any command that creates, reschedules, cancels, or edits an event.
// The event set is small, so upserting all of them keeps the logic trivial and
// correct (creates, in-place edits, and status changes all flow through).
export async function persistEvents(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of events) {
      await client.query(
        `INSERT INTO events
           (id, title, agenda, start_ts, end_ts, organizer_id, attendee_ids, room_id, type, status, priority, outlook_event_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           agenda = EXCLUDED.agenda,
           start_ts = EXCLUDED.start_ts,
           end_ts = EXCLUDED.end_ts,
           organizer_id = EXCLUDED.organizer_id,
           attendee_ids = EXCLUDED.attendee_ids,
           room_id = EXCLUDED.room_id,
           type = EXCLUDED.type,
           status = EXCLUDED.status,
           priority = EXCLUDED.priority,
           outlook_event_id = EXCLUDED.outlook_event_id,
           updated_at = EXCLUDED.updated_at`,
        [e.id, e.title, e.agenda, e.start, e.end, e.organizerId, e.attendeeIds, e.roomId, e.type, e.status, e.priority, e.outlookEventId ?? null, e.createdAt, e.updatedAt],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
