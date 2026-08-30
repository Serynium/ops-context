# ADR 0003: Retain primary-only D1 reads

- Status: accepted
- Date: 2026-08-31
- Decision owners: Ops Context maintainers
- Supersedes: none

## Context

Cloudflare D1 read replication can serve Sessions API reads from replicas near a
caller. Ordinary binding queries continue to use the primary. A D1 session provides
sequential consistency: writes are forwarded to the primary, later reads in that
session see those writes, and a bookmark can continue the consistency position in a
new request.

Ops Context has geographically movable administrator and MCP read paths, but it has
no production traffic or regional latency history yet. Event ingestion, Queue
consumption, delivery state, retention, and all mutations require the authoritative
write path. Administrator event creation/test flows require read-after-write, while
MCP cursor pages and grouped-event reads require monotonic reads within a logical
session.

Repository ports from issue #9 and stable query telemetry from issue #17 now exist.
The prototype therefore accepts either a `D1Database` or a request-scoped
`D1DatabaseSession` only at the internal adapter construction boundary. Application
and domain repository interfaces remain unchanged.

## Adoption threshold

Enable replicated reads only when a representative seven-day production window
meets all of these conditions:

1. At least two reader regions each have 1,000 or more successful PWA/MCP reads.
2. Primary-only D1 p95 wall time is at least 100 ms in one reader region and D1 time
   is at least 20% of the endpoint's p95 latency.
3. A mirrored Sessions canary reduces both median and p95 D1 wall time by at least
   30%, with an absolute p95 reduction of at least 50 ms.
4. At least 95% of eligible canary reads report `served_by_primary = false`, and
   error rate, bookmark rejection, replica-wait time, and rows read do not regress.

Measure `events.list`, `events.list_grouped_fast`, project/event detail, and the MCP
list/group tools separately. Do not average away a slow region or combine mutations
with replica-eligible reads.

## Evidence

The disposable benchmark placed a synthetic 10,000-event database primary in WNAM
and called it from a Worker executing in Sofia (`SOF`). Each mode used 30 indexed
50-row reads after warm-up:

| Mode | D1 service | Median wall | p95 wall | Median SQL | p95 SQL |
| --- | --- | ---: | ---: | ---: | ---: |
| Primary binding | WNAM primary | 195 ms | 218 ms | 0.342 ms | 0.470 ms |
| Unconstrained session | EEUR replica or WNAM primary | 39 ms | 207 ms | 0.320 ms | 1.045 ms |
| `first-primary` session | WNAM primary | 194 ms | 217 ms | 0.363 ms | 0.526 ms |

Rows read remained 50. Unconstrained Sessions improved median wall time by 80%, but
p95 improved by only 5% because some first queries still reached the primary. The
consistency probe successfully read its own write in the original session and from a
new session initialized with the returned bookmark. The Workers integration load
comparison also executes both paths against the same local D1 engine and asserts
identical results.

This is a deliberately adverse synthetic geometry, not production PWA/MCP evidence.
It demonstrates possible upside and validates the adapter/consistency design, but it
does not meet the production-volume, regional, p95-reduction, or replica-hit gates.

## Decision

Retain primary-only reads. Do not enable D1 read replication or propagate bookmarks
in the production HTTP surface yet. The current binding remains the repository
connection for PWA, MCP, ingestion, Queue, and scheduled programs.

Keep the narrow prototype and tests. A future change can construct request-scoped
repository layers from `env.DB.withSession(...)` without changing domain use cases:

- read-only PWA/MCP requests start unconstrained or from a validated client bookmark;
- administrator mutation flows use `first-primary`, perform writes through that same
  session, and return its bookmark so the next read sees the successful mutation;
- ingestion, Queue consumers, delivery transitions, retention, and repair continue
  to use the authoritative binding and never accept client bookmarks;
- all queries in one MCP request, including grouped lookup plus occurrence pages, use
  one session; a later pagination request may continue from the previous bookmark.

## Failure behavior, rollout, and rollback

Bookmarks are opaque and must be length-bounded before being passed to D1. Never log
them or use them as authorization. An invalid/rejected bookmark fails the request with
the existing sanitized repository error; it must not silently fall back to an older
unconstrained replica. A client may explicitly retry without its bookmark, which is a
new logical session. A replica that is behind waits until it reaches the bookmark;
track that wait in endpoint and D1 wall time and apply the normal request timeout.

For a future canary, deploy code that understands Sessions while replication remains
disabled, enable replication for a small reader cohort, and compare query name,
caller region, `served_by_region`, `served_by_primary`, wall time, rows read, errors,
and bookmark failures. Exclude all mutations from the unconstrained cohort.

Rollback first routes all new requests back to the primary binding and stops issuing
bookmarks. Existing bookmarks can be ignored after the code rollback. Then disable
read replication; Cloudflare may take up to 24 hours to retire replicas, but ordinary
binding reads already stay on the primary. No schema or data rollback is required.

## Consequences

- Production consistency and operational complexity remain unchanged.
- The adapter seam and tests demonstrate Sessions without leaking Cloudflare types
  into repository ports or domain use cases.
- The synthetic median benefit is preserved as a reason to re-evaluate, while clear
  production and tail-latency gates prevent premature adoption.

## References

- [Cloudflare D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Cloudflare D1 Sessions API](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)
