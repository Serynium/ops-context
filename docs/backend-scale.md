# Backend scale controls

The opt-in scale benchmark is the acceptance check for backend growth:

```bash
OPS_SCALE_PROJECTS=1000 OPS_SCALE_EVENTS=1000000 pnpm test:scale
```

It measures paginated reads, cached status, bounded token and prefix search,
authenticated HTTP acceptance, Queue persistence, subscription fan-out,
deferred retry, storage amplification, and bounded retention.

The primary Queue uses eight concurrent consumers. The sustained 1,000-event
local benchmark improved from about 329 events/s at four consumers to 362
events/s at eight; sixteen consumers fell back to about 335 events/s from D1
contention. Keep the dead-letter consumer at one to favor deterministic repair.

## Bounded endpoints

`GET /api/v1/projects` returns at most 100 projects. Pass `next_cursor` back as
`before`; `limit` accepts 1–100. Cursors follow the indexed
`(name COLLATE NOCASE, id)` order.

Global event search requires `since` within the last 30 days. Project-scoped
search remains available across that project's retained history. This prevents
a common token from making every account's history compete for the single D1
query executor.

Authenticated `GET /api/v1/status` is cached privately for 15 seconds. The
client response remains `Cache-Control: no-store`; successful mutations, Queue
batches, and retention invalidate the Worker Cache API entry.

Authenticated event reads are cached privately for five seconds and identical
concurrent requests in the same Worker isolate share one D1 query. Cache keys
are isolated across Worker starts and rotated after successful mutations, Queue
batches, and retention; clients still receive `Cache-Control: no-store`.

## Retention

The production Cron runs every 15 minutes. Each invocation remains bounded to
20 batches each of 500 events, 500 terminal push jobs, and 500 successful
deliveries. Successful
jobs are deleted atomically after their delivery row is recorded; dead and
legacy sent jobs are retained for seven days. Successful delivery history for
events older than seven days is removed; failed history follows event retention.
Active jobs are not affected. With compact IDs, the local benchmark reclaimed about 315
bytes per terminal job, or 3.15 KB/event with ten subscriptions, at one D1
row-write/job. Successful jobs now reclaim that space immediately and avoid the
later cleanup write.

New opaque IDs and deterministic external-event IDs encode their 128-bit values
as 22 base64url characters instead of 32 hexadecimal characters. Existing IDs
remain valid, avoiding a storage-heavy table rewrite while shortening each new
ID by 10 bytes. Contentless FTS and compact integer-millisecond time indexes
reduced the 10,000-event fixture from 10.6 to 8.9 MiB, raising projected 10 GB
capacity from 9.24 to 11.05 million events. RFC 3339 values remain the API and
durable-row representation; generated virtual integers replace repeated text
timestamps only inside hot ordering indexes.
On the noisy 100-event, ten-subscription ingestion fixture, the atomic five-minute
fingerprint window collapsed 1,000 potential jobs to 100 and reduced fan-out
storage from 3,973 to 1,638 bytes/event. A delivery row fell from 299 to about
123 database bytes. Delivery IDs use SQLite's rowid-backed
`INTEGER PRIMARY KEY` while the API casts them to opaque strings. Removing the
separate text-primary-key and global time indexes cut delivery creation from
four to two D1 `rows_written` (50%).

New projects default to warning-or-higher notifications. Repeated eligible
events with the same nonempty fingerprint share an atomic five-minute
notification window; every event remains stored, but only the winner creates
delivery jobs. Projects can explicitly opt back into info-level notifications.

`retention.completed` is logged as a warning when `continuationRequired` is
true; alert on repeated warnings because an expiry rate is exceeding the
current 960,000-row daily drain budget for any retention family.

Add project-based D1 routing only when production approaches the measured
single-database ceiling or write contention appears. Until a second binding and
migration policy exist, routing tokens and status flags provide no runtime value.
