# Web Push delivery lifecycle

Ops Context accepts events into Cloudflare Queue before touching D1. The `IngestEvent` consumer idempotently persists events/jobs and publishes `DeliverPush`; D1 is then the durable source of truth for active attempts, dead jobs, and delivery outcomes. Successful jobs are deleted atomically with their delivery insert. Cloudflare Queue is the only ordinary retry scheduler.

## State machine

```text
pending / queued / retrying
        │
        │ conditional D1 claim
        ▼
      sending
      │     │
      │     ├── success ───────────────► delivery row + job deleted
      │     │
      │     ├── permanent failure ─────► dead
      │     │
      │     └── transient failure
      │             │
      │             ├── attempts below ceiling ─► retrying + Queue delayed retry
      │             └── attempts exhausted ─────► dead
      │
      └── expired lease may be reclaimed
```

The D1 `attempts` counter is incremented by the conditional claim. `OPS_PUSH_MAX_ATTEMPTS` controls the durable ceiling and defaults to `6`.

## Retry ownership

A transient delivery failure is persisted as `retrying` with a future `available_at`. The current Queue message is then retried with the corresponding delay. No scheduled path republishes delivery jobs.

## Permanent outcomes

The following are terminal:

- successful delivery (durable delivery row; job removed);
- expired or unknown subscription responses such as 404/410 (`dead`, subscription disabled);
- non-retryable provider responses (`dead`);
- reaching the configured attempt ceiling (`dead`);
- a message delivered to the dead-letter Queue (`dead`).

A terminal transition clears its lease and retry guard and records `dead_at` for failed outcomes.

## Atomic finalization

Each delivery outcome uses a D1 batch for related state:

- job update or successful-job deletion;
- delivery-attempt history insert;
- optional subscription disabling.

This prevents a job from becoming terminal without the matching operator-visible delivery record.
Every statement is guarded by the claim's exact lease value. The delivery insert runs before the
state transition inside the same atomic batch, so a consumer whose lease expired cannot record an
attempt or overwrite the result of the consumer that reclaimed the job.

## Push-consumer D1 measurements

The normal success path now performs three repository operations, in order:

1. one conditional claim, which is the authoritative eligibility check;
2. one joined read of the claimed job, event, project, and subscription;
3. one atomic success-finalization batch.

The previous path performed a pre-claim job read, the claim, three separate context reads, and the
finalization batch. The following measurements use the Workers test runtime with one seeded
project, event, subscription, and queued job. They sum `D1Result.meta.rows_read` and
`D1Result.meta.rows_written` for a successful HTTP 201 delivery; the before queries were replayed
from commit `575a01e` and the after queries use the repository operations introduced for issue #12.

| Successful delivery | D1 round trips | SQL statements | Rows read | Rows written |
| --- | ---: | ---: | ---: | ---: |
| Before | 6 | 7 | 10 | 10 |
| After | 3 | 4 | 10 | 10 |

The row counters include index maintenance and the lease-ownership predicates. This change halves
network round trips while keeping measured D1 row consumption flat; the extra ownership checks are
what prevent a stale claimant from finalizing after lease reclamation.

## Crash recovery and scheduled work

`IngestEvent` stays unacknowledged until D1 persistence and downstream publication complete. A consumer crash therefore causes Queue redelivery, which idempotently resumes remaining fan-out. There is no delivery-repair query or Cron.

The only configured schedule is bounded retention every 15 minutes (`*/15 * * * *`) when automatic retention is wanted. Set `retention_days` to `0` and remove the `triggers` block from `wrangler.jsonc` for a no-Cron deployment, or when retention is managed externally.

Use a pause/drain window for the Queue-first cutover: stop predecessor HTTP/Sentry writers, Queue consumers, and scheduled triggers; wait at least five minutes for already-running publication and delivery invocations to finish; apply migration `0006_queue_first_ingestion.sql`; deploy the new Worker; then resume traffic and consumers. The migration terminalizes only legacy `pending` jobs older than that five-minute safety cutoff and only lease-less or expired `sending` jobs, so recent publication gaps and actively leased consumers remain untouched. Queue messages must match the tagged version 1 schema. The migration also adds the atomic fan-out marker, acceptance-alias table, and durable ingestion-failure ledger. Terminal counts are visible in administrator status, with reasons retained in D1.

Removing the five-minute repair schedule eliminates 288 periodic Worker invocations and their recovery D1 queries per day. Queue-first ingestion adds one Queue operation per accepted event. Events containing structured data also add one consolidated D1 settings read at acceptance so reusable credentials are removed before Queue storage; delivery fan-out operations are otherwise the same. The cost trade is event-proportional Queue work and redaction reads instead of constant polling.

## Authentication independence

Web Push delivery is independent from interactive administrator authentication. Cloudflare Access protects the PWA and private APIs, while Queue consumers use internal Worker bindings and durable D1 job state. No administrator password, cookie, or Access browser session is involved in delivery.

Issue #16 adds a narrowly scoped credential for service-worker subscription renewal so that background renewal also does not depend on an active interactive Access session.

## Idempotency

Queue delivery is at least once. The composite `(event_id, subscription_id)` key, conditional D1 claim, absent-successful-job check, and per-event Web Push topic make duplicate messages safe to process.

An unavoidable network edge remains: a push provider can accept a request immediately before the Worker terminates, before D1 records success. The Web Push topic allows the provider to replace a still-pending duplicate for the same event.
