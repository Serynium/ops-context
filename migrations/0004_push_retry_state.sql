-- Bounded, Queue-owned retry lifecycle for Web Push delivery.
-- Existing terminal `failed` jobs become `dead` jobs.

CREATE TABLE push_jobs_next (
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'queued', 'sending', 'retrying', 'sent', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at    TEXT NOT NULL,
  queued_at       TEXT,
  lease_until     TEXT,
  dead_at         TEXT,
  last_error      TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (event_id, subscription_id)
);

INSERT INTO push_jobs_next (
  event_id,
  subscription_id,
  state,
  attempts,
  available_at,
  queued_at,
  lease_until,
  dead_at,
  last_error,
  updated_at
)
SELECT
  event_id,
  subscription_id,
  CASE WHEN state = 'failed' THEN 'dead' ELSE state END,
  attempts,
  available_at,
  queued_at,
  lease_until,
  CASE WHEN state = 'failed' THEN updated_at ELSE NULL END,
  last_error,
  updated_at
FROM push_jobs;

DROP TABLE push_jobs;
ALTER TABLE push_jobs_next RENAME TO push_jobs;

CREATE INDEX push_jobs_recovery
  ON push_jobs(state, available_at, queued_at, lease_until);
CREATE INDEX push_jobs_lease
  ON push_jobs(state, lease_until);
CREATE INDEX push_jobs_dead
  ON push_jobs(state, dead_at)
  WHERE state = 'dead';
