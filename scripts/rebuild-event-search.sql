-- Idempotent event-search repair/backfill. Run through Wrangler after all D1
-- migrations are applied:
--   pnpm exec wrangler d1 execute ops-context --remote \
--     --file scripts/rebuild-event-search.sql
BEGIN TRANSACTION;

DELETE FROM event_search;

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

COMMIT;
