CREATE INDEX projects_name_id
  ON projects(name COLLATE NOCASE, id);

DROP INDEX events_occurred_at;
