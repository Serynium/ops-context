# Web Push delivery lifecycle

Ops Context accepts event writes independently from browser push providers. D1 is the durable record for each destination, while Cloudflare Queue provides asynchronous execution and delayed redelivery.

## State machine

Each `(event_id, subscription_id)` pair has exactly one `push_jobs` row.

```text
pending ──publish──> queued ──claim──> sending ──accepted──> sent
   ▲                    │                 │
   │                    │                 ├─ transient failure ─> retrying
   │                    │                 │                         │
   │                    │                 │                         └─ delayed Queue retry ─> sending
   │                    │                 │
   │                    │                 └─ permanent failure / attempt ceiling / DLQ ─> dead
   │                    │
   └──── low-frequency reconciliation of genuinely unpublished work ────┘
```

`sent` and `dead` are terminal. Duplicate Queue messages are acknowledged without sending another notification after either terminal state has been recorded.

## Retry ownership

Cloudflare Queue is the only ordinary transient-retry scheduler.

A retryable network error or provider response (`408`, `425`, `429`, or `5xx`) causes the consumer to:

1. atomically record the failed delivery attempt;
2. move the job to `retrying`;
3. set `available_at` using bounded exponential backoff;
4. request `message.retry({ delaySeconds })`.

D1 owns total attempt counting and terminal state. `OPS_PUSH_MAX_ATTEMPTS` controls the ceiling and defaults to `6`. When the claimed attempt reaches the ceiling, the job is marked `dead`, the final delivery attempt is recorded, and the Queue message is acknowledged.

## Permanent outcomes

Provider responses `404` and `410` indicate an expired subscription. The job is marked `dead` and the subscription is disabled in the same D1 batch as the delivery record.

Other non-retryable HTTP responses also mark the job `dead`, but do not disable the subscription automatically.

## Leases and duplicate delivery

Cloudflare Queues is at-least-once. A conditional D1 update claims a job and gives it a short lease before external I/O begins. Concurrent consumers cannot both claim the same active job. If a Worker stops while sending, a later message can reclaim the job after `lease_until` expires.

No database transaction can include a browser push provider. A provider may accept a notification immediately before the Worker stops. The Web Push `Topic` is derived from the event id so push services can coalesce a pending duplicate, while D1 prevents repeats after a terminal result is stored.

## Reconciliation and Cron

The current D1-first ingestion path has a narrow non-atomic gap between committing jobs and publishing Queue messages. Scheduled reconciliation is therefore limited to:

- `pending` jobs that were never published;
- stale `queued` jobs whose message appears lost;
- `sending` jobs with an expired lease;
- `retrying` jobs whose Queue retry is overdue by the reconciliation grace period.

It never republishes `sent` or `dead` jobs, and it does not race ordinary delayed retries.

Issue #14 will replace D1-first ingestion with Queue-first acceptance. That refactor removes push-recovery Cron entirely; only optional event retention remains scheduled.

## Dead-letter queue

The dead-letter Queue has its own consumer. Infrastructure-level messages arriving there are translated into an operator-visible `dead` job and delivery record, then acknowledged. A dead-letter message never starts a fresh normal retry cycle.

The administrator status response exposes `dead_jobs` so terminal delivery failures are visible without inspecting Cloudflare Queue internals.
