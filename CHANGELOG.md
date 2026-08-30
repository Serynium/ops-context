# Changelog

All notable changes to Ops Context are recorded here.

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
