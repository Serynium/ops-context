CREATE TABLE deliveries_next (
  id              INTEGER PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  response_status INTEGER,
  error           TEXT NOT NULL DEFAULT '',
  attempted_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

INSERT INTO deliveries_next
  (event_id, subscription_id, status, response_status, error, attempted_at, created_at)
SELECT event_id, subscription_id, status, response_status, error, attempted_at, created_at
FROM deliveries
ORDER BY attempted_at, id;

DROP TABLE deliveries;
ALTER TABLE deliveries_next RENAME TO deliveries;

CREATE INDEX deliveries_event_id ON deliveries(event_id, attempted_at DESC);
CREATE INDEX deliveries_attempted_at ON deliveries(attempted_at DESC);
