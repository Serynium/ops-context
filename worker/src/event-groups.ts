import { Effect } from "effect"
import { type RepositoryUnavailable } from "./errors.js"
import { Database } from "./services.js"

export const rebuildEventGroupsSql = `INSERT INTO event_groups (
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
WHERE group_rank = 1`

export const rebuildEventGroups: Effect.Effect<number, RepositoryUnavailable, Database> =
  Effect.gen(function*() {
    const db = yield* Database
    yield* db.batch("event_groups.rebuild", [
      { name: "event_groups.clear", sql: "DELETE FROM event_groups" },
      { name: "event_groups.backfill", sql: rebuildEventGroupsSql }
    ])
    const result = yield* db.first<{ readonly count: number }>(
      "event_groups.count_after_rebuild",
      "SELECT COUNT(*) AS count FROM event_groups"
    )
    return result?.count ?? 0
  })
