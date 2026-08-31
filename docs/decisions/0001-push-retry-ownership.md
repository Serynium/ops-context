# ADR 0001: Queue owns delivery retry timing

## Status

Accepted and implemented.

## Context

Cloudflare Queue delayed retries and scheduled D1 recovery previously acted as
competing retry schedulers. A transient failure could be placed back into a
recoverable D1 state while the same Queue message was already scheduled for
redelivery, creating duplicate publication and an unbounded retry cycle.

Queue-first ingestion has also removed the D1-before-Queue consistency gap, so
normal delivery and repair no longer require a scheduled publisher.

## Decision

Cloudflare Queue owns ordinary transient retry timing. D1 owns:

- durable idempotency;
- attempt counts;
- delivery leases;
- `available_at`;
- terminal `sent` or `dead` state;
- `dead_at` and the final delivery record.

A transient provider failure moves the durable job to `retrying` and asks Queue
for delayed redelivery. The application attempt ceiling is at most six, matching
the first delivery plus the primary Queue's five configured retries. Provider
permanent outcomes and exhausted attempts enter `dead` immediately.

The DLQ consumer is reconciliation, not another retry scheduler. It records a
terminal outcome when the primary Queue exhausts its infrastructure retries.

## Consequences

- Retry cost is bounded and observable.
- Cron cannot create a second ordinary retry message.
- Duplicate Queue delivery remains safe through the durable job key,
  conditional claim, and lease.
- `dead` is the persisted terminal state.
- Failed DLQ reconciliation emits a critical structured log for alerting.
