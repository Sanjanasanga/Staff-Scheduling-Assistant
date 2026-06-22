-- Chief of Staff Scheduling Assistant — Postgres schema.
-- Mirrors the domain types in src/types.ts. Times are stored as TIMESTAMPTZ
-- (instant-accurate) and surfaced to the app as ISO strings.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  department TEXT NOT NULL,
  timezone   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  location TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holidays (
  id     SERIAL PRIMARY KEY,
  date   DATE NOT NULL,
  name   TEXT NOT NULL,
  region TEXT NOT NULL CHECK (region IN ('US', 'HO'))
);

-- Mock recent emails the prep-builder pulls relevant context from.
CREATE TABLE IF NOT EXISTS emails (
  id      SERIAL PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  date    DATE NOT NULL,
  tags    TEXT[] NOT NULL DEFAULT '{}'
);

-- Mock file store the prep-builder pulls relevant documents from.
CREATE TABLE IF NOT EXISTS files (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  tags     TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  agenda       TEXT NOT NULL DEFAULT '',
  start_ts     TIMESTAMPTZ NOT NULL,
  end_ts       TIMESTAMPTZ NOT NULL,
  organizer_id TEXT NOT NULL REFERENCES users(id),
  attendee_ids TEXT[] NOT NULL DEFAULT '{}',
  room_id      TEXT REFERENCES rooms(id),
  type             TEXT NOT NULL CHECK (type IN ('meeting', 'working-session')),
  status           TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  priority         TEXT NOT NULL CHECK (priority IN ('strategic', 'operational', 'low')),
  outlook_event_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_ts);

-- Small key/value store for app state — currently the serialized MSAL token
-- cache for the connected Microsoft account (key = 'msal_cache').
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
