-- Full-text search covers the user-facing text fields and a normalized
-- projection of already-redacted structured payload values. The FTS rowid is
-- the owning event rowid, so exact scope, time, level, source, and cursor
-- filters remain on the normal, indexed events table.
CREATE VIRTUAL TABLE event_search USING fts5(
  title,
  body,
  source,
  fingerprint,
  payload,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

-- Only primitive payload values are projected. JSON syntax and keys are not
-- indexed, and the redaction marker is deliberately omitted. payload_json is
-- already redacted before the events row is written.
INSERT INTO event_search(rowid, title, body, source, fingerprint, payload)
SELECT
  e.rowid,
  e.title,
  e.body,
  e.source,
  e.fingerprint,
  COALESCE((
    SELECT group_concat(CAST(value.atom AS TEXT), ' ')
    FROM json_tree(e.payload_json) AS value
    WHERE value.atom IS NOT NULL
      AND value.type IN ('text', 'integer', 'real', 'true', 'false')
      AND CAST(value.atom AS TEXT) <> '[REDACTED]'
  ), '')
FROM events AS e;

CREATE TRIGGER event_search_after_insert
AFTER INSERT ON events
BEGIN
  INSERT INTO event_search(rowid, title, body, source, fingerprint, payload)
  VALUES (
    new.rowid,
    new.title,
    new.body,
    new.source,
    new.fingerprint,
    COALESCE((
      SELECT group_concat(CAST(value.atom AS TEXT), ' ')
      FROM json_tree(new.payload_json) AS value
      WHERE value.atom IS NOT NULL
        AND value.type IN ('text', 'integer', 'real', 'true', 'false')
        AND CAST(value.atom AS TEXT) <> '[REDACTED]'
    ), '')
  );
END;

CREATE TRIGGER event_search_after_update
AFTER UPDATE OF id, project_id, title, body, source, fingerprint, payload_json ON events
BEGIN
  DELETE FROM event_search WHERE rowid = old.rowid;
  INSERT INTO event_search(rowid, title, body, source, fingerprint, payload)
  VALUES (
    new.rowid,
    new.title,
    new.body,
    new.source,
    new.fingerprint,
    COALESCE((
      SELECT group_concat(CAST(value.atom AS TEXT), ' ')
      FROM json_tree(new.payload_json) AS value
      WHERE value.atom IS NOT NULL
        AND value.type IN ('text', 'integer', 'real', 'true', 'false')
        AND CAST(value.atom AS TEXT) <> '[REDACTED]'
    ), '')
  );
END;

CREATE TRIGGER event_search_after_delete
AFTER DELETE ON events
BEGIN
  DELETE FROM event_search WHERE rowid = old.rowid;
END;
