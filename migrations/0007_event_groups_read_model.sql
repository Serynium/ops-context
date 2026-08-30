CREATE TABLE event_groups (
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint      TEXT NOT NULL CHECK (fingerprint <> ''),
  latest_event_id  TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);

CREATE INDEX event_groups_latest
  ON event_groups(last_seen DESC, latest_event_id DESC);
CREATE INDEX event_groups_project_latest
  ON event_groups(project_id, last_seen DESC, latest_event_id DESC);

CREATE TRIGGER event_groups_after_event_insert
AFTER INSERT ON events
WHEN NEW.fingerprint <> ''
BEGIN
  INSERT INTO event_groups (
    project_id, fingerprint, latest_event_id, occurrence_count, first_seen, last_seen
  ) VALUES (
    NEW.project_id, NEW.fingerprint, NEW.id, 1, NEW.created_at, NEW.created_at
  )
  ON CONFLICT(project_id, fingerprint) DO UPDATE SET
    occurrence_count = event_groups.occurrence_count + 1,
    first_seen = MIN(event_groups.first_seen, excluded.first_seen),
    last_seen = MAX(event_groups.last_seen, excluded.last_seen),
    latest_event_id = CASE
      WHEN excluded.last_seen > event_groups.last_seen
        OR (excluded.last_seen = event_groups.last_seen
          AND excluded.latest_event_id > event_groups.latest_event_id)
      THEN excluded.latest_event_id
      ELSE event_groups.latest_event_id
    END;
END;

CREATE TRIGGER event_groups_after_event_delete
AFTER DELETE ON events
WHEN OLD.fingerprint <> ''
BEGIN
  DELETE FROM event_groups
  WHERE project_id = OLD.project_id
    AND fingerprint = OLD.fingerprint
    AND occurrence_count = 1;

  UPDATE event_groups
  SET occurrence_count = occurrence_count - 1
  WHERE project_id = OLD.project_id AND fingerprint = OLD.fingerprint;

  UPDATE event_groups
  SET
    first_seen = (
      SELECT MIN(created_at) FROM events
      WHERE project_id = OLD.project_id AND fingerprint = OLD.fingerprint
    ),
    last_seen = (
      SELECT MAX(created_at) FROM events
      WHERE project_id = OLD.project_id AND fingerprint = OLD.fingerprint
    ),
    latest_event_id = (
      SELECT id FROM events
      WHERE project_id = OLD.project_id AND fingerprint = OLD.fingerprint
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
  WHERE project_id = OLD.project_id
    AND fingerprint = OLD.fingerprint
    AND (first_seen = OLD.created_at OR latest_event_id = OLD.id);
END;

INSERT INTO event_groups (
  project_id, fingerprint, latest_event_id, occurrence_count, first_seen, last_seen
)
WITH ranked AS (
  SELECT
    project_id,
    fingerprint,
    id,
    COUNT(*) OVER (PARTITION BY project_id, fingerprint) AS occurrence_count,
    MIN(created_at) OVER (PARTITION BY project_id, fingerprint) AS first_seen,
    MAX(created_at) OVER (PARTITION BY project_id, fingerprint) AS last_seen,
    ROW_NUMBER() OVER (
      PARTITION BY project_id, fingerprint
      ORDER BY created_at DESC, id DESC
    ) AS group_rank
  FROM events
  WHERE fingerprint <> ''
)
SELECT project_id, fingerprint, id, occurrence_count, first_seen, last_seen
FROM ranked
WHERE group_rank = 1;
