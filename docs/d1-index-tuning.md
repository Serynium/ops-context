# D1 index tuning baseline

This report records the evidence used for migration `0006_tune_event_indexes.sql`.
It is a reproducible local D1/SQLite workload baseline, not a claim about
production traffic. Production decisions must continue to use the stable query
telemetry described in [D1 query observability](d1-observability.md).

## Method and representative workload

Measurements were taken on 2026-08-31 from the issue #17 telemetry head
`ac6ecc4a4d18936a826fb0f3dd078ae79299d852`, using the SQLite 3.43.2 engine
behind Wrangler's local D1 persistence. All migrations through `0005` were
applied before the baseline.

The deterministic fixture contained 10 projects, 10,000 events distributed
evenly by project/level/source, 500 fingerprints, 5,000 push jobs with 15%
recoverable states, 10,000 deliveries, and 300 silence rules. Event-list queries
used the application's normal page size plus lookahead (`LIMIT 51`); recovery
used `LIMIT 100`. `ANALYZE` ran before each comparison.

For each stable query name, run the application SQL with representative bound
values through:

```text
EXPLAIN QUERY PLAN <query>;
.stats on
<query>;
```

The table reports SQLite virtual-machine steps as a deterministic local proxy
for work. These are not D1 billable `rows_read`; after deployment, compare
`db.rows_read`, `db.rows_written`, and `db.duration_ms` for the same traffic
window through the issue #17 telemetry.

## Baseline and measured result

| Query shape | Before plan | Before VM steps | After plan | After VM steps | Effect |
| --- | --- | ---: | --- | ---: | ---: |
| `events.list`, global | `events_created_at`, no sort | 461 | unchanged | 461 | 0% |
| `events.list`, project | `events_project_fingerprint_created` + temp sort | 8,674 | `events_project_created`, no sort | 266 | -96.9% |
| `events.list`, project + level | `events_project_id` + temp sort | 6,816 | `events_project_created`, filter in index order | 1,426 | -79.1% |
| `events.list`, project + source | `events_project_id` + temp sort | 7,266 | `events_project_created`, filter in index order | 1,221 | -83.2% |
| `events.list_grouped`, project | fingerprint index + two temp sorts | 113,310 | fingerprint index + one outer sort | 95,867 | -15.4% |
| `push_jobs.list_recoverable` | multi-index `push_jobs_recovery` / `push_jobs_lease` | 12,552 | unchanged | 12,552 | 0% |
| `deliveries.list_for_event` | `deliveries_event_id`, no sort | 31 | unchanged | 31 | 0% |
| `projects.get_by_api_key_hash` | unique API-key index | 19 | unchanged | 19 | 0% |
| `silences.match` | `silences_lookup` + precedence sort | 227 | unchanged | 227 | 0% |

The highest-cost fixture query is grouped event listing, followed by active-job
recovery and project-scoped event listing. Grouped listing now separates empty
fingerprints (which are intentionally never grouped) from real fingerprints;
the latter follows the existing `events_project_fingerprint_created` order and
removes one temporary sort without another index. Recovery already performs
indexed state/range searches and never scans the broad `push_jobs` table, so no
recovery index change is justified by this baseline.

## Selected and rejected indexes

`events_project_created(project_id, created_at DESC, id DESC)` targets
project-scoped `events.list`, including its `(created_at, id)` cursor. Its
leading column fully replaces `events_project_id`, so migration `0006` creates
the ordered index before dropping the redundant project-only index. On the
10,000-event fixture the replacement used 442,368 bytes versus 114,688 bytes
for the old index: about 32.8 additional bytes per event. The number of indexes
maintained per event write is unchanged.

Two narrower candidates were measured but rejected:

| Candidate | Filtered-list VM steps | Fixture storage | Decision |
| --- | ---: | ---: | --- |
| `(project_id, level, created_at DESC, id DESC)` | 267 | 512,000 bytes | Reject pending production evidence; adds an index write for every event |
| `(project_id, source, created_at DESC, id DESC)` | 267 | 499,712 bytes | Reject pending production evidence; adds an index write for every event |

Those candidates reduce local filtered-list work further, but together add
about 1 MiB per 10,000 events and two more index-maintenance writes. The selected
ordered project index already removes the sort and cuts the measured work by
79–83%. Add either specialized index only if production `rows_read /
rows_returned` and request frequency show that its filter is persistently hot.

## Correctness and query-plan guardrails

`worker/test/d1-index-tuning.test.ts` applies the real migration chain and
asserts that event ordering and cursor pagination remain `(created_at DESC, id
DESC)`, project/level/source filters remain correct, repeated fingerprints are
grouped, empty fingerprints remain separate, and every measured read family
uses its intended index. In particular, the recovery plan must contain both
`push_jobs_recovery` and `push_jobs_lease` and must not contain `SCAN push_jobs`.

## Rollout and rollback

1. Deploy issue #17 telemetry and capture a representative pre-deploy window
   grouped by `db.query.name`.
2. Apply migrations during a normal low-traffic deployment. Index creation
   reads existing `events` rows but does not rewrite or reinterpret them; the old
   project index remains available until its replacement has been created.
3. Compare the same traffic shape and duration after deployment. Watch
   `events.list`, `events.list_grouped`, event-write `db.rows_written`, p95
   duration, D1 storage, and failures.
4. If project-list reads regress, ship a new forward migration that runs:

   ```sql
   CREATE INDEX events_project_id ON events(project_id);
   DROP INDEX events_project_created;
   ```

   Deploy the previous grouped-query implementation with that forward
   migration. Do not edit or re-run migration `0006` on an existing database.

