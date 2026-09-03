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

export const rebuildEventGroupsByLevelSql = `INSERT INTO event_groups_by_level (
  level, project_id, fingerprint, latest_event_id,
  occurrence_count, first_seen, last_seen
)
WITH ranked AS (
  SELECT
    level,
    project_id,
    fingerprint,
    id,
    COUNT(*) OVER (PARTITION BY level, project_id, fingerprint) AS occurrence_count,
    MIN(created_at) OVER (PARTITION BY level, project_id, fingerprint) AS first_seen,
    MAX(created_at) OVER (PARTITION BY level, project_id, fingerprint) AS last_seen,
    ROW_NUMBER() OVER (
      PARTITION BY level, project_id, fingerprint
      ORDER BY created_at DESC, id DESC
    ) AS group_rank
  FROM events
  WHERE fingerprint <> ''
)
SELECT level, project_id, fingerprint, id, occurrence_count, first_seen, last_seen
FROM ranked
WHERE group_rank = 1`
