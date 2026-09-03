ALTER TABLE events ADD COLUMN created_at_ms INTEGER GENERATED ALWAYS AS (
  CAST(strftime('%s', created_at) AS INTEGER) * 1000 +
  CASE WHEN substr(created_at, 20, 1) = '.' THEN CAST(substr(created_at, 21, 3) AS INTEGER) ELSE 0 END
) VIRTUAL;

ALTER TABLE event_groups ADD COLUMN last_seen_ms INTEGER GENERATED ALWAYS AS (
  CAST(strftime('%s', last_seen) AS INTEGER) * 1000 +
  CASE WHEN substr(last_seen, 20, 1) = '.' THEN CAST(substr(last_seen, 21, 3) AS INTEGER) ELSE 0 END
) VIRTUAL;

ALTER TABLE event_groups_by_level ADD COLUMN last_seen_ms INTEGER GENERATED ALWAYS AS (
  CAST(strftime('%s', last_seen) AS INTEGER) * 1000 +
  CASE WHEN substr(last_seen, 20, 1) = '.' THEN CAST(substr(last_seen, 21, 3) AS INTEGER) ELSE 0 END
) VIRTUAL;

ALTER TABLE deliveries ADD COLUMN attempted_at_ms INTEGER GENERATED ALWAYS AS (
  CAST(strftime('%s', attempted_at) AS INTEGER) * 1000 +
  CASE WHEN substr(attempted_at, 20, 1) = '.' THEN CAST(substr(attempted_at, 21, 3) AS INTEGER) ELSE 0 END
) VIRTUAL;

DROP INDEX events_created_at;
CREATE INDEX events_created_at ON events(created_at_ms DESC, id DESC);
DROP INDEX events_project_created;
CREATE INDEX events_project_created ON events(project_id, created_at_ms DESC, id DESC);
DROP INDEX events_empty_fingerprint_created;
CREATE INDEX events_empty_fingerprint_created ON events(created_at_ms DESC, id DESC)
  WHERE fingerprint = '';
DROP INDEX events_project_empty_fingerprint_created;
CREATE INDEX events_project_empty_fingerprint_created
  ON events(project_id, created_at_ms DESC, id DESC) WHERE fingerprint = '';
DROP INDEX events_level_empty_fingerprint_created;
CREATE INDEX events_level_empty_fingerprint_created
  ON events(level, created_at_ms DESC, id DESC) WHERE fingerprint = '';
DROP INDEX events_level_project_empty_fingerprint_created;
CREATE INDEX events_level_project_empty_fingerprint_created
  ON events(level, project_id, created_at_ms DESC, id DESC) WHERE fingerprint = '';

DROP INDEX event_groups_latest;
CREATE INDEX event_groups_latest ON event_groups(last_seen_ms DESC, latest_event_id DESC);
DROP INDEX event_groups_project_latest;
CREATE INDEX event_groups_project_latest
  ON event_groups(project_id, last_seen_ms DESC, latest_event_id DESC);
DROP INDEX event_groups_by_level_latest;
CREATE INDEX event_groups_by_level_latest
  ON event_groups_by_level(level, last_seen_ms DESC, latest_event_id DESC);
DROP INDEX event_groups_by_level_project_latest;
CREATE INDEX event_groups_by_level_project_latest
  ON event_groups_by_level(level, project_id, last_seen_ms DESC, latest_event_id DESC);

DROP INDEX deliveries_event_id;
CREATE INDEX deliveries_event_id ON deliveries(event_id, attempted_at_ms DESC);
