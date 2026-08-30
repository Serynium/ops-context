-- Queue-first ingestion removes scheduled repair publication. Jobs from the
-- previous D1-first publisher that have no durable Queue retry are made
-- operator-visible instead of remaining stranded indefinitely.
ALTER TABLE events ADD COLUMN fanout_completed_at TEXT;

-- Every event created by an older release already completed (or abandoned)
-- its D1-first fan-out. Marking it complete prevents a producer retry from
-- creating jobs for subscriptions added after that original event.
UPDATE events SET fanout_completed_at = created_at;

UPDATE push_jobs
SET state = 'dead',
    lease_until = NULL,
    dead_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_error = 'terminalized during Queue-first ingestion migration; delivery was not durably queued',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state = 'pending'
   OR (
     state = 'sending'
     AND (
       lease_until IS NULL
       OR lease_until < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     )
   );

CREATE TABLE ingestion_failures (
  event_id    TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  external_id TEXT,
  error       TEXT NOT NULL,
  failed_at   TEXT NOT NULL
);
CREATE INDEX ingestion_failures_failed_at ON ingestion_failures(failed_at DESC);

-- A request accepted while D1 is unavailable cannot discover a random event ID
-- assigned by an older release. The consumer records the deterministic accepted
-- ID as an alias if the external-ID uniqueness constraint resolves to that row.
CREATE TABLE event_aliases (
  alias_id   TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX event_aliases_event_id ON event_aliases(event_id);
