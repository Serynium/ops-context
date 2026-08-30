# Web Push delivery lifecycle

Ops Context accepts event writes independently from Web Push delivery. D1 is the durable source of truth for events, jobs, attempts, and terminal state. Cloudflare Queue is the only ordinary retry scheduler.

## State machine

```text
pending / queued / retrying
        │
        │ conditional D1 claim
        ▼
      sending
      │     │
      │     ├── success ───────────────► sent
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

A transient delivery failure is persisted as `retrying` with a future `available_at`. The current Queue message is then retried with the corresponding delay.

The scheduled reconciliation query explicitly excludes `retrying` jobs while their retry guard is active. This prevents Queue and scheduled maintenance from both publishing the same ordinary retry.

## Permanent outcomes

The following are terminal:

- successful delivery (`sent`);
- expired or unknown subscription responses such as 404/410 (`dead`, subscription disabled);
- non-retryable provider responses (`dead`);
- reaching the configured attempt ceiling (`dead`);
- a message delivered to the dead-letter Queue (`dead`).

A terminal transition clears its lease and retry guard and records `dead_at` for failed outcomes.

## Atomic finalization

Each delivery outcome uses a D1 batch for related state:

- job state update;
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

## Reconciliation

Scheduled maintenance is a narrow recovery mechanism for:

- jobs that were committed but never published;
- queued messages that appear to have been lost;
- abandoned `sending` leases.

It is not the normal retry mechanism and does not restart terminal jobs. Issue #14 replaces the remaining D1-first reconciliation path with Queue-first ingestion and removes the repair Cron.

## Authentication independence

Web Push delivery is independent from interactive administrator authentication. Cloudflare Access protects the PWA and private APIs, while Queue consumers use internal Worker bindings and durable D1 job state. No administrator password, cookie, or Access browser session is involved in delivery.

Issue #16 adds a narrowly scoped credential for service-worker subscription renewal so that background renewal also does not depend on an active interactive Access session.

## Idempotency

Queue delivery is at least once. The composite `(event_id, subscription_id)` key, conditional D1 claim, terminal-state check, and per-event Web Push topic make duplicate messages safe to process.

An unavoidable network edge remains: a push provider can accept a request immediately before the Worker terminates, before D1 records success. The Web Push topic allows the provider to replace a still-pending duplicate for the same event.
