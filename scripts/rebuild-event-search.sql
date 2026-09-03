-- Idempotent event-search repair/backfill. Run through Wrangler after all D1
-- migrations are applied:
--   pnpm exec wrangler d1 execute ops-context --remote \
--     --file scripts/rebuild-event-search.sql
-- Wrangler submits the file as an atomic D1 batch, so explicit transaction
-- statements are intentionally omitted.

INSERT INTO event_search(event_search) VALUES('delete-all');

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
