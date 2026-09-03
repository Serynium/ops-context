# Changelog

All notable changes to Flarebox are recorded here.

## [Unreleased]

## [0.4.0] — 2026-09-03

### Added

- A measured D1 Sessions/read-replication evaluation with adoption and rollback guidance. Production reads remain primary-only pending representative regional p95 evidence.
- A measured FTS5 event-search index with Unicode token and explicit-prefix search, redacted structured-value projection, atomic trigger maintenance, and an idempotent rebuild path.
- A measured `event_groups` read model for default grouped inbox pages, with atomic insert/delete maintenance, retention-safe recomputation, project isolation, migration backfill, and an authenticated idempotent repair operation.
- Grouped-inbox D1 measurements and integration coverage comparing the read model to the exact dynamic query. On the 10,000-event fixture, rows read fell from 51,502 to 154 and median local latency from 8 ms to below 1 ms.
- Stable D1 query names with span and structured-log telemetry for duration, rows returned, rows read, and rows written. SQL text, bound parameters, payloads, and driver error messages are excluded.
- D1 observability guidance for read amplification, write volume, latency, failures, and before/after performance comparisons.
- A measured D1 index baseline, query-plan integration guardrails, and safe rollout/rollback guidance for event listing, grouping, recovery, delivery history, project authentication, and silence matching.
- Queue-first event acceptance with schema-versioned `IngestEvent` and `DeliverPush` commands, rollout decoding for legacy delivery messages, `202 Accepted` responses, deterministic `external_id` retry ids, atomic fan-out initialization, and durable ingestion-DLQ outcomes.
- Workers-runtime coverage for Queue-send failure, eventual consistency, duplicate ingestion, post-commit recovery, and partial fan-out.

- Strict Effect Schema event ingestion with field-level validation issues, calendar-valid RFC 3339 timestamps, HTTP(S)-only actions, bounded structured context, and a 256 KiB raw request limit.
- Event-ingestion contract documentation and Workers-runtime coverage for oversized bodies.

- Bounded Web Push delivery attempts with explicit `retrying`, `sent`, and terminal `dead` job states. Queue delayed retry is the ordinary retry authority, while the dead-letter Queue records an operator-visible terminal outcome.
- Workers-runtime reliability tests covering duplicate Queue delivery, lease reclamation, retry exhaustion, delayed-retry/Cron separation, unpublished-job recovery, and DLQ handling.
- Deterministic Workerd integration coverage for concurrent delivery claims, atomic event/job creation, external-id idempotency, lost-publication recovery, provider failures, cascade deletion, Queue ack/retry outcomes, and the Access/same-origin boundary.
- Separate fast Node unit-test and Cloudflare Workers integration-test commands for local development and CI.
- Administrator status now reports the number of terminal `dead_jobs`.
- D1 migration `0004_push_retry_state` for the new delivery state machine and indexes.

- Sentry SDK ingestion through `POST /api/{id}/envelope/`. Server-side Sentry clients can use a Flarebox project API key as the DSN public key; exception and message events reuse the existing redaction, silence, grouping, D1, durable push-job, and Queue delivery pipeline. Gzip and deflate envelopes, Sentry fingerprints, curated event context, and non-error item ignoring are supported.

### Changed

- Renamed the project to Flarebox and replaced the application and PWA icons with the Burst mark.
- Separated the compact app mark from the rounded README logo and replaced the violet primary UI accents with a bright orange palette.
- Default grouped pages now scan materialized groups rather than all fingerprinted occurrences. Level, source, fingerprint, search, time, and silence filters continue to use the exact dynamic query.
- Project-scoped event listing now uses an ordered `(project_id, created_at DESC, id DESC)` index in place of the redundant project-only index. Grouped reads use the existing fingerprint index while preserving distinct empty-fingerprint events.
- Removed the five-minute D1 delivery-repair Cron and narrowed scheduled work to bounded retention every 15 minutes. Deployments with retention disabled can omit Cron entirely.
- Event fields are rejected instead of silently truncated, and invalid `occurred_at` values no longer fall back to the server timestamp. The same contract is enforced by the HTTP boundary and application service.

- Push retry scheduling is bounded by `OPS_PUSH_MAX_ATTEMPTS` (default `6`). Queue delayed retry is the sole retry scheduler; delivery-state updates and attempt history are finalized atomically through D1 batches.

- Replaced the application-level Zod MCP schemas with Effect Schema contracts adapted through Standard Schema V1. HTTP and MCP boundaries now share the same schema system, and `zod` is no longer a direct dependency.

## [0.3.0] — 2026-08-30

### Added

- Fingerprint grouping for `GET /api/v1/events?grouped=true`, including occurrence count and first/last seen timestamps. Groups are always scoped to a project and every active filter is applied before grouping.
- Event actions in ingestion payloads: up to three `{ label, url }` entries. Labels are limited to 40 characters, URLs must be absolute, and `javascript:`, `data:`, and `file:` schemes are refused.
- Action buttons in event details and encrypted Web Push notifications. Notification clicks open the matching action URL through the PWA service worker.
- PWA event export actions: Copy, Copy as Markdown, and Web Share. Markdown is sectioned for coding and operations agents.
- Read-only Model Context Protocol endpoint at `/mcp`, implemented as an Effect service using the official `@modelcontextprotocol/server` SDK on the Cloudflare `Request`/`Response` boundary. Tools: `list_projects`, `list_events`, `search_events`, `get_event`, and `get_event_group`.
- MCP authentication through the `OPS_MCP_TOKEN` bearer secret, an administrator session, or administrator Basic credentials. Project API keys are explicitly refused.
- Event filters for `fingerprint`, `search`, `since`, and `until`.
- Settings fields `mcp_enabled` and `mcp_token_set`.

### Changed

- The PWA inbox can toggle repeat grouping and drill into all occurrences for a fingerprint.
- Project controls use compact inline rows.
- Inbox level badges have a consistent width, and long event titles and bodies truncate before the level column.
- D1 migration `0003_actions_groups_mcp` adds `events.actions_json`, the grouped-events index, and the MCP enablement setting.
- The service worker cache is bumped and no longer caches the MCP endpoint.
- CI now type-checks, tests, builds the PWA, and performs a dry-run Cloudflare Worker bundle.

## [0.2.0] — 2026-08-29

### Changed

- Refactored the Worker backend to schema-first Effect v4 HTTP APIs, tagged errors, services, Layers, Effect SQL for D1, and reusable managed runtimes.

## [0.1.0] — 2026-08-29

### Added

- Cloudflare Worker, D1 persistence, Queue-based Web Push delivery, scheduled retention and recovery, administrator sessions, project API keys, silences, and an installable PWA.
