# ADR 0002: Retain one modular Worker deployment

## Status

Accepted on 2026-08-31. Revisit when a trigger below is sustained and issues #8, #9,
and #10 have established the required test and application boundaries.

## Context

The Worker currently serves the public ingestion API, administrator API, static PWA,
and Access-protected MCP endpoint, consumes the push and dead-letter Queues, and runs
scheduled maintenance. MCP and delivery have different dependency, security, CPU,
and concurrency profiles, so separate deployments could eventually improve isolation.
They would also introduce multiple configurations, coordinated releases, shared D1
schema compatibility, more dashboards, and more rollback paths.

Issue #22 requires measured evidence before introducing that operational boundary.
It also depends on the delivery integration tests in #8, repository ports in #9, and
protocol-independent errors in #10. Issue state was checked against `main`: #8 is
only partially complete, while application modules still call the generic `Database`
service and use HTTP-shaped `AppError` values, confirming that #9 and #10 are not yet
implemented.

## Current evidence

Run the reproducible production bundle analysis with:

```bash
pnpm analyze:worker
```

The 2026-08-31 `main` baseline, using the locked Wrangler 4.127.1 toolchain and
minification enabled, is:

| Metric | Current value | Interpretation |
| --- | ---: | --- |
| Worker JavaScript | 890,913 B raw / 263,764 B gzip | Well below Cloudflare's 3 MB compressed Free-plan limit; no size-driven deployment failure |
| MCP SDK | 218,021 B raw (24.5%) | Material optional dependency |
| Zod, currently transitive through MCP | 106,561 B raw (12.0%) | Material optional dependency |
| Local MCP adapter | 6,184 B raw (0.7%) | Small application-specific boundary |
| MCP-attributable upper bound | 330,766 B raw (37.1%) | Justifies continuing to measure, but is not a counterfactual split-bundle size because tree shaking and shared imports can change |

Cloudflare documents the current Worker size and startup limits in its
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) page.
The `D1Database` capabilities referenced below are documented by the
[D1 Workers Binding API](https://developers.cloudflare.com/d1/worker-api/).

No production CPU, cold-start, request-volume, Queue-backlog, or cross-profile failure
dataset is available in the repository or attached to the issue. Absence of an export
must not be interpreted as zero usage or zero impact. It means there is no measured
operational problem for a split to solve yet.

Before reconsidering this decision, retain at least 14 days of per-profile request
count, CPU time, wall time, error rate, and latency, plus Queue depth, oldest-message
age, retry rate, and dead-letter rate. A split becomes a concrete proposal when one or
more of these is sustained:

- MCP causes at least a 20% regression in public-route p95 startup or CPU time, or the
  public bundle approaches a platform/account limit.
- Push oldest-message age breaches its delivery SLO and independent consumer
  concurrency would address the measured bottleneck.
- MCP or delivery failures consume the public API error budget.
- Security policy requires binding-level or dependency-level isolation despite the D1
  limitation described below.
- Ownership or release cadence has actually diverged between profiles.

## Options considered

| Option | Bundle and CPU | Request volume | Failure isolation | Deployment complexity | Security |
| --- | --- | --- | --- | --- | --- |
| 1. One modular Worker | Ships the current 890,913 B bundle; one warm runtime can reuse shared Layers | One deployment absorbs all profiles; current volumes are not exported | Queue/MCP defects share an isolate deployment, although handler failures are bounded | Lowest: one configuration, schema rollout, release, and rollback | Public routes load MCP/push dependencies and the deployment holds all bindings |
| 2. MCP Worker | Removes the MCP SDK and its currently MCP-only schema dependency from the public graph; actual split sizes must be dry-run measured | Independent MCP limits only help once MCP traffic or CPU is material | MCP release and runtime failures stop affecting public ingestion | Adds Access routing, a second release, D1 schema compatibility, observability, and rollback | Removes MCP code from public ingress. The current `D1Database` binding exposes mutation methods, so a shared direct binding grants capability beyond the read-only application port |
| 3. Delivery Worker | Public Worker loses Web Push consumer code; delivery gets independent Queue concurrency | Directly addresses a measured backlog without changing ingestion volume | Provider, retry, and Queue consumer failures are isolated | Adds coordinated producer/consumer schemas, secrets, Queue configuration, and rollback | VAPID secrets and Queue consumers leave public ingress; delivery still requires D1 mutation access |
| 4. Delivery plus maintenance Worker | Similar to option 3; maintenance CPU leaves public requests | Schedule and delivery can scale together only if their ownership aligns | Isolates both background profiles, but couples their failure domains | Most moving parts and a broader background deployment | Public deployment keeps only D1, producer, assets, and public authentication bindings; background deployment receives D1, consumer, schedule, and push secrets |

Business-noun services were rejected. Events, durable push jobs, attempts, and delivery
history share one consistency boundary and must not be split into independently owned
microservices.

## Decision

Keep option 1. The optional MCP dependency is material in the raw bundle, but there is
no measured startup, CPU, reliability, backlog, security-policy, ownership, or release
problem that offsets the operational cost of a second deployment. More importantly,
the shared repository and error boundaries required for a safe split are not complete.

Continue improving internal module boundaries. Shared application ports, tagged
errors, Queue message types, and storage schemas must remain dependency-free from
HTTP, MCP, Wrangler, and Web Push adapters. Issue #9 should introduce narrow
use-case-oriented repository ports rather than a generic shared CRUD package. Until
that work lands, extracting a deployment would copy or reach through implementation
details and create circular coupling.

Because no second deployment is introduced:

- the current least-privilege binding set remains unchanged;
- independent deployment dry runs and cross-deployment tests are not applicable;
- existing Workers-runtime tests remain the end-to-end contract for event storage,
  Queue acknowledgement, retries, leases, terminal outcomes, and recovery;
- `pnpm check` remains the single CI dry run and the existing deployment is the single
  rollback unit.

## Requirements for a future split

A replacement ADR must include measured before/after bundles and production profile
metrics. It must not be accepted until #8, #9, and #10 are complete and the following
controls exist.

### Bindings and secrets

- Public: static assets, D1, Queue producer, public/admin Access configuration; no MCP
  SDK route, VAPID private key, Queue consumer, dead-letter consumer, or cron trigger.
- MCP: MCP Access audience and the smallest read-oriented application layer; no
  assets, Queue binding, VAPID secret, consumer, or cron trigger. A direct
  `D1Database` binding exposes mutation methods, so either accept and document that
  risk or expose a narrow authenticated service binding from the data owner.
- Delivery: D1 mutation port, primary and dead-letter Queue consumers, VAPID secrets,
  and push limits; no assets, public routes, MCP audience, or administrator API.
- Maintenance, if moved: D1 plus only the Queue producer operations used for recovery.

### CI and compatibility

Each Wrangler configuration must have an independent minified dry run and recorded
raw/gzip size. CI must then run a Workers-runtime event-to-push test that starts at the
public ingestion boundary, observes the Queue message contract, runs the delivery
consumer, and verifies the terminal D1 job and delivery record. Duplicate delivery,
retry exhaustion, lease recovery, schema-version skew in both rollout orders, and DLQ
handling are required. Unit tests or two handlers sharing one broad test Layer are not
a substitute for the cross-deployment contract.

### Rollout and rollback

1. Deploy backward-compatible D1 migrations first.
2. Deploy the new consumer dark, with its Queue consumer disabled, and verify bindings.
3. Deploy the producer/public Worker while the original consumer still understands the
   message schema.
4. Transfer Queue consumption, verify backlog age, error rate, terminal outcomes, and
   duplicate rate, then remove the old consumer in a later release.
5. Roll back by restoring the previous consumer route/configuration before reverting
   producer code. Never roll back a migration while either deployment can write the
   newer schema; use forward-fix migrations.

MCP should use a weighted or alternate hostname cutover with both deployments reading
the same compatible schema. Rollback returns the route to the single Worker; it does
not require a D1 rollback.

## Consequences

- Operations remain simple and the current runtime/test model stays authoritative.
- Public ingestion continues to include MCP and delivery dependencies for now.
- The repository has a repeatable bundle baseline and explicit evidence thresholds.
- A future split has a least-privilege target, CI contract, and reversible rollout plan
  rather than treating deployment extraction as a file move.
## 2026-08-31 hardening amendment

The repository now has Workers-runtime D1/Queue integration tests, decoded repository ports, tagged protocol-independent errors, Queue-first ingestion, FTS, and a grouped-event read model.

The Static Assets router does not always forward `ctx.access`. This is not a reason to split the deployment: the Worker now verifies the forwarded Access JWT against Cloudflare's JWKS when the direct runtime context is absent. The single-Worker decision remains accepted. Reconsider it only when production measurements or security policy require an independent deployment boundary.

