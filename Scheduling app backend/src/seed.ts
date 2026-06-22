// One-shot setup/reset: ensures the target database exists, applies the schema,
// and (re)loads the demo data. Run with `npm run db:setup`.
//
//   - Reference rows (users, rooms, holidays, emails, files) are static.
//   - Sample events are rebuilt relative to "today" on each run, so re-seeding
//     refreshes the demo calendar. Re-running wipes any data you created.
import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";
import { DATABASE_URL } from "./db.js";
import { seedTables } from "./seedTables.js";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

// Connect to the "postgres" maintenance DB and CREATE the target DB if missing.
async function ensureDatabase(): Promise<string> {
  const target = new URL(DATABASE_URL);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) {
      // DB names can't be parameterized; dbName comes from our own config.
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[seed] created database "${dbName}"`);
    } else {
      console.log(`[seed] database "${dbName}" already exists`);
    }
  } finally {
    await admin.end();
  }
  return dbName;
}

async function seed(): Promise<void> {
  const dbName = await ensureDatabase();
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(SCHEMA);
    console.log("[seed] schema applied");

    await client.query("BEGIN");
    await client.query("TRUNCATE events, emails, files, holidays, rooms, users RESTART IDENTITY CASCADE");
    await seedTables((text, params) => client.query(text, params as unknown[]));
    await client.query("COMMIT");
    console.log(`[seed] demo data loaded into "${dbName}"`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

seed()
  .then(() => {
    console.log("[seed] done ✅");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[seed] failed ❌:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
