INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES
  ('setup_completed', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('redact_keys', '[]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
