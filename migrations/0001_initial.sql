PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  icon         TEXT NOT NULL DEFAULT '',
  api_key_hash TEXT NOT NULL UNIQUE,
  notify       INTEGER NOT NULL DEFAULT 1 CHECK (notify IN (0, 1)),
  min_level    TEXT NOT NULL DEFAULT 'info'
               CHECK (min_level IN ('info', 'success', 'warning', 'error', 'critical')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE push_subscriptions (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT 'PWA device',
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_seen_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX push_subscriptions_enabled ON push_subscriptions(enabled, created_at);

CREATE TABLE silences (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  field      TEXT NOT NULL CHECK (field IN ('fingerprint', 'title', 'source')),
  value      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX silences_lookup ON silences(field, value, project_id);

CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  external_id  TEXT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT '',
  level        TEXT NOT NULL DEFAULT 'info'
               CHECK (level IN ('info', 'success', 'warning', 'error', 'critical')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  fingerprint  TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  silence_id   TEXT
);
CREATE INDEX events_project_id ON events(project_id);
CREATE INDEX events_occurred_at ON events(occurred_at);
CREATE INDEX events_created_at ON events(created_at DESC, id DESC);
CREATE INDEX events_level ON events(level);
CREATE INDEX events_fingerprint ON events(fingerprint);
CREATE INDEX events_source ON events(source);
CREATE UNIQUE INDEX events_external_id
  ON events(project_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE push_jobs (
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'queued', 'sending', 'sent', 'failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  available_at   TEXT NOT NULL,
  queued_at      TEXT,
  lease_until    TEXT,
  last_error     TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (event_id, subscription_id)
);
CREATE INDEX push_jobs_recovery ON push_jobs(state, available_at, queued_at);
CREATE INDEX push_jobs_lease ON push_jobs(state, lease_until);

CREATE TABLE deliveries (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  response_status INTEGER,
  error           TEXT NOT NULL DEFAULT '',
  attempted_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX deliveries_event_id ON deliveries(event_id, attempted_at DESC);
CREATE INDEX deliveries_attempted_at ON deliveries(attempted_at DESC);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_sessions_expires_at ON admin_sessions(expires_at);
