// Shared INSERT logic for loading demo data, with no side effects on import.
// Used by seed.ts (after a truncate, for an explicit reset) and by ensureSeeded()
// in db.ts (auto-seed a fresh/empty database on first boot — e.g. on a deploy).
import { buildSeedEvents, emails, files, holidays, rooms, users } from "./seedData.js";

// A query runner — pg's Pool.query and Client.query both satisfy this shape.
export type Run = (text: string, params?: unknown[]) => Promise<unknown>;

export async function seedTables(run: Run): Promise<void> {
  for (const u of users) {
    await run("INSERT INTO users (id, name, email, department, timezone) VALUES ($1, $2, $3, $4, $5)", [
      u.id, u.name, u.email, u.department, u.timezone,
    ]);
  }
  for (const r of rooms) {
    await run("INSERT INTO rooms (id, name, capacity, location) VALUES ($1, $2, $3, $4)", [r.id, r.name, r.capacity, r.location]);
  }
  for (const h of holidays) {
    await run("INSERT INTO holidays (date, name, region) VALUES ($1, $2, $3)", [h.date, h.name, h.region]);
  }
  for (const m of emails) {
    await run("INSERT INTO emails (from_id, subject, snippet, date, tags) VALUES ($1, $2, $3, $4, $5)", [
      m.from, m.subject, m.snippet, m.date, m.tags,
    ]);
  }
  for (const f of files) {
    await run("INSERT INTO files (name, owner_id, tags) VALUES ($1, $2, $3)", [f.name, f.owner, f.tags]);
  }
  for (const e of buildSeedEvents()) {
    await run(
      `INSERT INTO events
         (id, title, agenda, start_ts, end_ts, organizer_id, attendee_ids, room_id, type, status, priority, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [e.id, e.title, e.agenda, e.start, e.end, e.organizerId, e.attendeeIds, e.roomId, e.type, e.status, e.priority, e.createdAt, e.updatedAt],
    );
  }
}
