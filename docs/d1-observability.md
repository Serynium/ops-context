# D1 query observability

Every application D1 operation has a stable, low-cardinality query name at the database service boundary. Successful operations emit an Effect span and a structured `d1.query` log with:

- `db.query.name`
- `db.operation` (`query`, `write`, or `batch`)
- `db.rows_returned`
- `db.rows_read`
- `db.rows_written`
- `db.duration_ms`
- `db.served_by_region` and `db.served_by_primary` for remote requests

Failed operations emit `d1.query.failed` with the query name, operation, and a safe `error.class`. SQL text, bound parameters, driver error messages, and event payloads are deliberately excluded from both records.

Remote D1 results also expose `served_by_region` and `served_by_primary`. These fields
are required for a future read-replication canary, but are unavailable in local
Workerd tests. Correlate them with the caller region and endpoint wall time; SQL
duration alone excludes the cross-region trip that replication is intended to avoid.
See [ADR 0003](decisions/0003-retain-primary-d1-reads.md).

## Operational views

In Workers Logs, filter structured logs to `event = "d1.query"`. Create saved views or dashboard tables grouped by `db.query.name` for:

1. Highest read amplification: sum `db.rows_read` divided by sum `db.rows_returned`. Treat a zero-row result separately rather than dividing by zero.
2. Highest write volume: sum `db.rows_written`, descending.
3. Slowest operations: p95 `db.duration_ms`, descending.
4. Most expensive operations: sum `db.rows_read` and sum `db.rows_written`, descending.
5. Failure rate: count `event = "d1.query.failed"` divided by all D1 query events, grouped by `db.query.name` and `error.class`.

The read-amplification ratio is a useful index signal: a sustained increase means D1 scans more rows to return the same application result. Capture the same time window and traffic shape before and after performance changes so issues #11, #12, #13, #18, and #19 can compare these measures.

The first measured index review, including its local baseline, rejected
candidates, storage/write tradeoffs, and production rollout procedure, is
recorded in [D1 index tuning baseline](d1-index-tuning.md).

Batch spans use the logical batch name. Each successful statement also emits its own stable name and D1 row metadata, so repeated fan-out writes aggregate without creating per-row cardinality.

Cloudflare observability is enabled in `wrangler.jsonc`. If production volume makes full query logging noisy, configure Cloudflare log sampling at deployment level; keep trace and log sampling aligned when comparing ratios.
