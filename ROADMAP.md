# Roadmap

Flarebox intentionally starts as a small operational event inbox rather than a full incident-management system.

## Completed foundations

- Effect v4 schema-first HTTP and MCP contracts.
- Cloudflare Worker, D1, Queues, scheduled maintenance, and Static Assets.
- Installable PWA and encrypted Web Push.
- Project keys, redaction, silences, grouping, actions, Sentry ingestion, and read-only MCP.
- Bounded Queue retries and terminal delivery state.
- Cloudflare Access-only authentication for the private PWA, administrator API, and MCP surfaces.
- Workers-runtime testing with real D1 migrations.
- A measured materialized fast path for the default grouped inbox.

## Measurement-driven work

These features should be implemented only when production measurements justify them:

- D1 Sessions/read-replication evaluation retained primary-only reads pending production regional p95 evidence (#21; [ADR 0003](docs/decisions/0003-retain-primary-d1-reads.md)).
- Splitting MCP or push delivery into separate Worker deployments (#22).

## Possible product features

### Attachments

Store large event artifacts in R2 and keep metadata in D1.

### Acknowledgements

Track acknowledged, resolved, and assigned events.

### Digest and quiet hours

Create scheduled summaries and delivery windows.

### Integrations

Provide small adapters for common error trackers, build systems, and observability platforms while keeping the core HTTP contract stable.

## Non-goals unless requirements change

- A heavy frontend framework.
- Microservices split by business noun.
- Durable Objects for ordinary CRUD or push fan-out.
- Cloudflare Workflows for short notification delivery.
- A permanent VM or container for the main application.
- Reintroducing application-managed administrator passwords or sessions.
