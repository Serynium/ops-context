# ADR 0001: Queue owns delivery retry timing

## Status

Accepted.

## Context

Cloudflare Queue delayed retries and scheduled D1 recovery previously acted as competing retry schedulers. A transient failure could be moved back to a recoverable D1 state while the same Queue message was already scheduled for redelivery, allowing duplicate publication and unbounded retry cycles.

## Decision

Cloudflare Queue owns ordinary transient retry timing. D1 owns durable idempotency, attempt counts, leases, and the terminal failed/dead outcome.

A transient failure records `retry_scheduled_until`; scheduled recovery excludes such jobs. When the durable attempt ceiling is reached, the job enters the existing terminal `failed` state and records `dead_at`. Provider-permanent outcomes enter the same terminal state immediately.

Queue-first ingestion removes delivery-repair Cron processing entirely. This ADR remains the delivery-state contract for that architecture.

## Consequences

- Retry cost is bounded and observable.
- Cron cannot create a second ordinary retry message.
- Duplicate Queue delivery remains safe through the durable job key and claim.
- `failed` is the persisted terminal state; `dead_at` makes its dead-letter semantics explicit without rebuilding the existing D1 table.
