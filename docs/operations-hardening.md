# Production hardening and cost controls

## Deployment surfaces

Use three hostnames with one Worker deployment:

```text
ingest.ops.example.com  public network, project bearer key required
app.ops.example.com     Cloudflare Access user identity required
mcp.ops.example.com     Cloudflare Access user or service token required
```

Workers Static Assets run in front of the user Worker. The router does not always
forward `ctx.access`, so the Worker keeps `ctx.access` as the fast path and
otherwise verifies `Cf-Access-Jwt-Assertion` against:

```text
https://<OPS_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs
```

The verifier requires RS256, the configured Access issuer, the surface-specific
audience, a valid time window, and an application token. It also requires the
request hostname and route to match the configured app or MCP surface. Invalid
or missing keys, signatures, issuers, audiences, expiries, hostnames, and
surfaces fail closed. Caller-supplied `x-ops-access-*` headers are always
stripped, as is the Access assertion before the Effect application receives the
request.

Required variables:

```text
OPS_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
OPS_ACCESS_APP_AUD=<application audience>
OPS_ACCESS_MCP_AUD=<MCP application audience>
```

## Queue and D1 lifecycle

An accepted event creates one `IngestEvent` Queue message. Its consumer writes
the event and durable delivery jobs, publishes one `DeliverPush` message per
eligible subscription, and then performs one event-level
`fanout_published_at` update.

There is no per-subscription publication update. A crash during fan-out causes
the `IngestEvent` message to be retried and may republish already accepted
delivery messages. The delivery consumer's conditional D1 claim makes those
duplicates harmless. The event-level marker is written only after every
publication succeeds, so an interrupted fan-out remains recoverable without a
Cron repair path.

Ordinary retry ownership belongs only to Cloudflare Queue. D1 records attempts,
leases, retry availability, and terminal `sent` or `dead` state. The application
attempt ceiling is capped at six, matching the first delivery plus five Queue
retries in `wrangler.jsonc`.

## Queue payload billing

Cloudflare bills Queue payloads in 64,000-byte chunks. Ops Context emits a
`queue.command.large` warning when an `IngestEvent` command crosses that
boundary. The hard safety ceiling remains 127,900 bytes.

For capacity planning, let:

```text
E = accepted events
S = average eligible subscriptions per event
C = IngestEvent payload billing chunks, normally 1
Qretry = additional Queue operations caused by retries or DLQ processing
```

The fan-out marker change removes D1 writes, not Queue messages, so the Queue
formula is unchanged:

```text
Before: Queue operations ~= 3E(C + S) + Qretry
After:  Queue operations ~= 3E(C + S) + Qretry
Delta:  0 for the publication-marker change
```

The factor of three represents the ordinary write, read, and successful delete
lifecycle for each message. Retries and DLQ handling add operations outside the
successful lower bound. Keep ordinary event commands below 64 KB even though
the protocol permits a larger message.

## D1 write model

The following formulas count logical row writes for a successful first-pass
ingestion and delivery. They exclude retries, FTS and event-group triggers,
secondary-index maintenance, and provider-specific internal work.

Before the hardening change:

```text
1 event insert
+ 1 event fan-out snapshot update
+ S push-job inserts
+ S per-destination mark_queued updates
+ S claim updates
+ S terminal-state updates
+ S delivery inserts

= E(2 + 5S)
```

After the hardening change:

```text
1 event insert
+ 1 event fan-out snapshot update
+ 1 event-level fanout_published_at update
+ S push-job inserts
+ S claim updates
+ S terminal-state updates
+ S delivery inserts

= E(3 + 4S)
```

Therefore:

```text
After - Before = E(1 - S)
Writes saved       = E(S - 1)
```

At zero destinations the recoverability marker costs one additional event
write; at one destination the lower bound is unchanged; above one destination
it saves one D1 write for every destination after the first. Duplicate Queue
messages can add claim attempts or terminal checks, but conditional updates keep
the durable result idempotent.

The database adapter always annotates tracing spans with D1 metadata. Routine
successful query logs are sampled, while failures, slow queries, high-read
queries, high-write queries, and high read-amplification queries are always
logged.

## DLQ alerts

Create a Workers Logs alert for either event:

```text
queue.dlq.terminalized
queue.dlq.reconciliation_failed
```

`queue.dlq.terminalized` means the primary Queue exhausted its retries and Ops
Context recorded a terminal outcome. `queue.dlq.reconciliation_failed` is more
urgent: the DLQ consumer could not persist the terminal outcome, commonly
because D1 was unavailable. The log contains only command type and opaque IDs,
never event payloads, credentials, or provider response bodies.

The remaining failure mode is prolonged D1 unavailability. The DLQ consumer
retries reconciliation, but after the configured DLQ retry envelope is
exhausted there may be no durable terminal record. The
`queue.dlq.reconciliation_failed` alert is therefore the operator signal to
restore D1 access or preserve/replay the affected command while its safe opaque
identifiers are still available in Workers Logs.

## Retention measurement and bounds

Retention deletes at most 500 events per D1 statement and at most 20 batches per
daily invocation. A result with `continuationRequired: true` means the next
scheduled run must continue draining the backlog.

Use existing D1 telemetry to measure production retention cost after deployment:

1. Filter Workers Logs for `event = "d1.query"` and
   `db.query.name = "events.prune"`.
2. Record `db.duration_ms`, `db.rows_read`, and `db.rows_written` across several
   scheduled runs, including a run with an established retention backlog.
3. Investigate any invocation at or above 100 ms, 1,000 rows read, 100 rows
   written, or the configured read-amplification threshold. These records are
   emitted at full fidelity rather than sampled.
4. Check the `retention completed` result for `batches`, `prunedEvents`, and
   `continuationRequired`; repeated continuation indicates the daily budget is
   not draining the backlog fast enough.

The bounded, ordered delete introduced here limits each statement even when
cascade and read-model triggers are expensive. If production telemetry still
exceeds the thresholds, reduce `RETENTION_BATCH_SIZE` or replace row-triggered
group repair with a measured set-oriented repair before increasing the daily
batch budget.

## No-Cron deployment

The default deployment uses:

```text
wrangler.jsonc
```

For a deployment with no scheduled work, use:

```bash
pnpm deploy:no-cron
```

which deploys `wrangler.no-cron.jsonc`. Disable retention explicitly in
Settings when using the no-Cron configuration. `pnpm check` performs dry-runs
for both configurations, and both generated output directories are ignored by
Git.

## Deployment acceptance test

After applying migrations and deploying:

1. An Access-authenticated user can call `/api/v1/access/me` and a private API.
2. The same requests fail without Access and with an invalid issuer, audience,
   signature, expiry, hostname, or route surface.
3. An Access service token can call `/mcp` but cannot mutate the app API.
4. A project key can ingest an event but cannot authorize app or MCP routes.
5. `POST /api/v1/events` returns `202`; the event subsequently appears in D1.
6. Duplicate `IngestEvent` and `DeliverPush` messages do not duplicate events or
   terminal deliveries.
7. A forced interruption during fan-out recovers without any
   `push_jobs.mark_queued` write.
8. A transient push failure uses delayed Queue retry and eventually reaches
   `sent` or `dead` within the six-attempt application ceiling.
9. An event larger than 64 KB emits `queue.command.large` without logging the
   event payload; an event above the hard Queue ceiling is rejected.
10. A forced DLQ message creates an operator-visible terminal record and alert.
11. Both standard and no-Cron Wrangler dry-runs pass in CI.
12. `main` requires a pull request, the `check` status, resolved conversations,
    no force pushes, and no branch deletion.

The final branch-protection rule is a GitHub repository setting and is not
created by application code. Enable it manually, then verify the repository
reports `main` as protected before merging this change.
