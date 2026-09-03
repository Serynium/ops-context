DROP TRIGGER event_search_after_insert;
DROP TRIGGER event_search_after_update;
DROP TRIGGER event_search_after_delete;
DROP TABLE event_search;

CREATE VIRTUAL TABLE event_search USING fts5(
  title,
  body,
  source,
  fingerprint,
  payload,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

INSERT INTO event_search(rowid, title, body, source, fingerprint, payload)
SELECT
  e.rowid,
  e.title,
  e.body,
  e.source,
  e.fingerprint,
  COALESCE((
    SELECT group_concat(CASE value.type
      WHEN 'true' THEN 'true'
      WHEN 'false' THEN 'false'
      ELSE CAST(value.atom AS TEXT)
    END, ' ')
    FROM json_tree(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END) AS value
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
      SELECT group_concat(CASE value.type
        WHEN 'true' THEN 'true'
        WHEN 'false' THEN 'false'
        ELSE CAST(value.atom AS TEXT)
      END, ' ')
      FROM json_tree(CASE WHEN json_valid(new.payload_json) THEN new.payload_json ELSE '{}' END) AS value
      WHERE value.atom IS NOT NULL
        AND value.type IN ('text', 'integer', 'real', 'true', 'false')
        AND CAST(value.atom AS TEXT) <> '[REDACTED]'
    ), '')
  );
END;

CREATE TRIGGER event_search_after_update
AFTER UPDATE OF id, project_id, title, body, source, fingerprint, payload_json ON events
BEGIN
  INSERT INTO event_search(event_search, rowid, title, body, source, fingerprint, payload)
  VALUES (
    'delete',
    old.rowid,
    old.title,
    old.body,
    old.source,
    old.fingerprint,
    COALESCE((
      SELECT group_concat(CASE value.type
        WHEN 'true' THEN 'true'
        WHEN 'false' THEN 'false'
        ELSE CAST(value.atom AS TEXT)
      END, ' ')
      FROM json_tree(CASE WHEN json_valid(old.payload_json) THEN old.payload_json ELSE '{}' END) AS value
      WHERE value.atom IS NOT NULL
        AND value.type IN ('text', 'integer', 'real', 'true', 'false')
        AND CAST(value.atom AS TEXT) <> '[REDACTED]'
    ), '')
  );
  INSERT INTO event_search(rowid, title, body, source, fingerprint, payload)
  VALUES (
    new.rowid,
    new.title,
    new.body,
    new.source,
    new.fingerprint,
    COALESCE((
      SELECT group_concat(CASE value.type
        WHEN 'true' THEN 'true'
        WHEN 'false' THEN 'false'
        ELSE CAST(value.atom AS TEXT)
      END, ' ')
      FROM json_tree(CASE WHEN json_valid(new.payload_json) THEN new.payload_json ELSE '{}' END) AS value
      WHERE value.atom IS NOT NULL
        AND value.type IN ('text', 'integer', 'real', 'true', 'false')
        AND CAST(value.atom AS TEXT) <> '[REDACTED]'
    ), '')
  );
END;

CREATE TRIGGER event_search_after_delete
AFTER DELETE ON events
BEGIN
  INSERT INTO event_search(event_search, rowid, title, body, source, fingerprint, payload)
  VALUES (
    'delete',
    old.rowid,
    old.title,
    old.body,
    old.source,
    old.fingerprint,
    COALESCE((
      SELECT group_concat(CASE value.type
        WHEN 'true' THEN 'true'
        WHEN 'false' THEN 'false'
        ELSE CAST(value.atom AS TEXT)
      END, ' ')
      FROM json_tree(CASE WHEN json_valid(old.payload_json) THEN old.payload_json ELSE '{}' END) AS value
      WHERE value.atom IS NOT NULL
        AND value.type IN ('text', 'integer', 'real', 'true', 'false')
        AND CAST(value.atom AS TEXT) <> '[REDACTED]'
    ), '')
  );
END;
