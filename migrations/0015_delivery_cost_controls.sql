DROP INDEX deliveries_attempted_at;

ALTER TABLE event_groups ADD COLUMN last_notified_at TEXT;
ALTER TABLE event_groups ADD COLUMN last_notified_event_id TEXT;
