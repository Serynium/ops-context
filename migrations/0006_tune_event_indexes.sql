-- Replace the project-only index with one that also satisfies the stable
-- event ordering and cursor used by project-scoped inbox reads.
--
-- The leading project_id column preserves every lookup supported by the old
-- index. Creating the replacement first keeps the migration safe for existing
-- data and avoids an interval without project lookup coverage.

CREATE INDEX events_project_created
  ON events(project_id, created_at DESC, id DESC);

DROP INDEX events_project_id;
