// Postgres connection layer. The whole app talks to the database through this
// single pool. Configure with the DATABASE_URL env var (see .env.example); the
// default targets a local "cos_scheduler" database owned by the current OS user,
// which is what a stock Homebrew Postgres install provides out of the box.
import dotenv from "dotenv";
// override: true so values in .env win over stale shell exports (e.g. a leftover
// ANTHROPIC_API_KEY placeholder in ~/.zshrc would otherwise shadow the real key).
dotenv.config({ override: true });
import pg from "pg";
import { readFileSync } from "node:fs";
import { seedTables } from "./seedTables.js";

const defaultUser = process.env.PGUSER ?? process.env.USER ?? "postgres";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? `postgresql://${defaultUser}@localhost:5432/cos_scheduler`;

// Local Postgres (localhost) needs no SSL; managed hosts (Render, Neon, …) do.
const isLocal = /@(localhost|127\.0\.0\.1)\b/.test(DATABASE_URL);
export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

// A dropped backend connection shouldn't crash the process.
pool.on("error", (err) => {
  console.error("[cos-scheduler] unexpected idle pg client error:", err.message);
});

// Thin query helper for one-off reads.
export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

// The full canonical schema (all CREATE TABLE/INDEX IF NOT EXISTS — idempotent).
const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

// Create any missing tables. Safe to run on every boot; on a fresh database
// (e.g. a managed Postgres on first deploy) this stands the schema up so the app
// self-initializes without a separate setup step.
export async function applySchema(): Promise<void> {
  await pool.query(SCHEMA);
}

// Idempotent column/table upgrades for databases created before later features
// (e.g. the Outlook integration). CREATE TABLE IF NOT EXISTS won't add columns
// to an existing table, so these ALTERs cover already-provisioned databases.
export async function migrate(): Promise<void> {
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS outlook_event_id TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

// Load demo data only if the database is empty — so a fresh deploy comes up
// populated, but restarts keep any data created since.
export async function ensureSeeded(): Promise<void> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  if (rows[0]?.n === 0) {
    await seedTables((text, params) => pool.query(text, params as unknown[]));
    console.log("[cos-scheduler] empty database — loaded demo data");
  }
}

// Tiny key/value accessors for app_state (used for the MSAL token cache).
export async function getState(key: string): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>("SELECT value FROM app_state WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await pool.query(
    "INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, value],
  );
}
