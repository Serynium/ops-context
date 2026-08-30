ALTER TABLE events ADD COLUMN actions_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX events_project_fingerprint_created
  ON events(project_id, fingerprint, created_at DESC, id DESC);

INSERT INTO settings (key, value, updated_at)
VALUES ('mcp_enabled', 'false', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO NOTHING;
