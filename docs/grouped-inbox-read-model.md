# Grouped inbox read model

The default `GET /api/v1/events?grouped=true` path uses `event_groups`, a
project-scoped read model maintained by D1 triggers in the same transaction as
each event insert or delete. The table stores only non-empty fingerprints.
Empty fingerprints continue to appear as independent inbox rows.

The fast path is used when the only optional query inputs are `project`,
`before`, and `limit`. Filters whose exact semantics depend on individual
occurrences—`level`, `source`, `fingerprint`, `search`, `since`, `until`, and
`silenced`—transparently use the window-function query instead. Both paths use
the same `(created_at, id)` ordering and cursor contract.

## Enablement threshold and measurement

The read model was enabled only if a representative 10,000-event fixture met
both conditions:

1. At least 80% fewer D1 rows read for the default 51-row page.
2. Identical results to the dynamic query across project boundaries, empty
   fingerprints, cursor pagination, inserts, and retention deletes.

Measurements were taken on 2026-08-31 with Wrangler 4.127.1 local D1 after all
migrations through `0007`, using 500 non-empty fingerprint groups and 10 warm
timed runs after one warm-up. The integration test records D1 result metadata
and wall-clock latency around the same query execution.

| Query | D1 rows read | Median latency | Rows returned |
| --- | ---: | ---: | ---: |
| Dynamic window query | 51,502 | 8 ms | 51 |
| `event_groups` fast path | 154 | <1 ms | 51 |

The fast path reduced rows read by 99.7% and median local latency by more than
87.5%. This exceeds the enablement threshold and addresses the highest-cost
query identified in [the index-tuning baseline](d1-index-tuning.md). These are
reproducible local D1 measurements, not production traffic claims. After
deployment, compare `events.list_grouped` with `events.list_grouped_fast` using
the stable telemetry in [D1 query observability](d1-observability.md).

The benchmark and query-plan guard are in
`worker/test/event-groups.integration.test.ts`.

## Inserts, retention, and project isolation

Migration `0007_event_groups_read_model.sql` backfills existing events and
installs these invariants:

- `(project_id, fingerprint)` is the primary key, so groups cannot cross
  projects.
- The insert trigger atomically increments the count and updates first/latest
  timestamps and the `(created_at, id)` representative.
- The delete trigger decrements ordinary deletions and recomputes boundary
  values only when retention removes the first or latest occurrence.
- Deleting the final occurrence removes the group; deleting a project cascades
  its groups.
- Empty fingerprints never enter the read model.

## Idempotent repair

The migration performs the initial backfill. To repair drift later, sign in to
the private PWA through Cloudflare Access and run this same-origin request from
the browser console:

```js
await fetch("/api/v1/maintenance/event-groups/rebuild", { method: "POST" })
  .then((response) => response.json())
```

The response is `{ "groups": number }`. The operation requires administrator
authentication and same-origin protection. It clears and rebuilds the table in
one atomic D1 batch, so a failure rolls back the complete repair. Repeating the
operation produces the same read model from the authoritative `events` table.

Run repair after restoring or manually modifying event data. Ordinary event
creation and retention do not require it because triggers maintain the model.
