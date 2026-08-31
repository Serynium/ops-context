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
audience, a valid time window, and an application token. Caller-supplied
`x-ops-access-*` headers are always stripped.

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
duplicates harmless.

Ordinary retry ownership belongs only to Cloudflare Queue. D1 records attempts,
leases, retry availability, and terminal `sent` or `dead` state. The application
attempt ceiling is capped at six, matching the first delivery plus five Queue
retries in `wrangler.jsonc`.

## Queue payload billing

Cloudflare bills Queue payloads in 64,000-byte chunks. Ops Context emits a
`queue.command.large` warning when an `IngestEvent` command crosses that
boundary. The hard safety ceiling remains 127,900 bytes.

Planning formula:

```text
E = accepted events
S = average receiving subscriptions
C = IngestEvent billing chunks, normally 1

Queue operations ~= 3 * E * (C + S) + retry reads
```

Keep ordinary event commands below 64 KB even though the protocol permits a
larger message.

## D1 write model

The successful lower bound after the fan-out change is:

```text
1 event insert
+ 1 event-level fan-out publication update
+ S push-job inserts
+ S claim updates
+ S terminal-state updates
+ S delivery inserts

= E * (2 + 4S)
```

FTS, event-group triggers, and secondary indexes add further writes. The
database adapter always annotates tracing spans with D1 metadata, but routine
successful query logs are sampled. Failures, slow queries, high-read queries,
high-write queries, and high read-amplification queries are always logged.

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

## Retention

Retention deletes at most 500 events per D1 statement and at most 20 batches per
daily invocation. A result with `continuationRequired: true` means the next
scheduled run must continue draining the backlog.

The default deployment uses:

```text
wrangler.jsonc
```

For a deployment with no scheduled work, use:

```bash
pnpm deploy:no-cron
```

which deploys `wrangler.no-cron.jsonc`. Disable retention explicitly in
Settings when using the no-Cron configuration.

## Deployment acceptance test

After applying migrations and deploying:

1. An Access-authenticated user can call `/api/v1/access/me` and a private API.
2. The same requests fail without Access.
3. An Access service token can call `/mcp` but cannot mutate the app API.
4. A project key can ingest an event but cannot authorize app or MCP routes.
5. `POST /api/v1/events` returns `202`; the event subsequently appears in D1.
6. Duplicate `IngestEvent` and `DeliverPush` messages do not duplicate events or
   terminal deliveries.
7. A transient push failure uses delayed Queue retry and eventually reaches
   `sent` or `dead`.
8. A forced DLQ message creates an operator-visible terminal record and alert.
9. Both standard and no-Cron Wrangler dry-runs pass in CI.
10. `main` requires a pull request, the `check` status, resolved conversations,
    no force pushes, and no branch deletion.

The final branch-protection rule is a GitHub repository setting and is not
created by application code.
