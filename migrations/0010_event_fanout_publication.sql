-- Replace one write per push destination with one event-level publication
-- marker. Existing events are considered published so a replayed historical
-- IngestEvent command cannot create fresh fan-out.
ALTER TABLE events ADD COLUMN fanout_published_at TEXT;

UPDATE events
SET fanout_published_at = COALESCE(fanout_completed_at, created_at);
