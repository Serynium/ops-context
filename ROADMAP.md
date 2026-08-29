# Roadmap

## Implemented in the initial scaffold

- Effect v4 service boundary.
- Cloudflare Worker fetch, Queue, and Cron handlers.
- D1 migrations and repositories.
- Project API keys and administrator sessions.
- Event ingestion, redaction, pagination, filters, levels, and idempotency.
- Project management and key rotation.
- PWA installation and Web Push subscription management.
- Encrypted Web Push delivery through Cloudflare Queues.
- Durable jobs, leasing, retries, delivery history, stale-job recovery, and retention.
- Silence rules and unsilencing.
- Minimal production dashboard.

## Next hardening milestones

1. Add Cloudflare Worker-runtime tests using `@cloudflare/vitest-plugin`, including isolated D1 and Queue bindings.
2. Add OpenAPI generation from Effect schemas and generate the browser client from the contract.
3. Move manual request decoding to Effect v4 `Schema` codecs and declarative `HttpApi` endpoints once the RC API is pinned for the release.
4. Add administrator login rate limiting, session revocation UI, and optional Cloudflare Access integration.
5. Add subscription heartbeat/health checks and richer delivery diagnostics.
6. Add event grouping, acknowledgement, search, charts, and inbox keyboard navigation.
7. Add import tooling for an existing Boop SQLite database.
8. Add integrations for GitHub Actions, Effect applications, Node.js, Elixir, and generic webhooks.
9. Add local end-to-end tests for Chrome plus a documented Safari/iOS release checklist.
10. Add backup/export endpoints and D1 time-travel recovery documentation.
