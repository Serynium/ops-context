-- Replace one write per push destination with one event-level publication
-- marker. Historical events with no pending jobs are already fully published.
-- Keep the marker NULL when a legacy fan-out still has pending jobs so the
-- in-flight IngestEvent retry can publish those destinations after deployment.
ALTER TABLE events ADD COLUMN fanout_published_at TEXT;

UPDATE events
SET fanout_published_at = COALESCE(fanout_completed_at, created_at)
WHERE NOT EXISTS (
  SELECT 1
  FROM push_jobs
  WHERE push_jobs.event_id = events.id
    AND push_jobs.state = 'pending'
);
