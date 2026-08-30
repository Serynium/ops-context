# Ops Context

A compact operational event inbox with encrypted PWA push notifications, built on Cloudflare and Effect v4.

Ops Context is the Cloudflare + Effect interpretation of the same idea behind Boop: an application posts an operational event, the event is stored in a focused inbox, and enrolled browser installations receive native notifications. There is no Slack workspace, Telegram bot, native mobile binary, or always-running server to operate.

## What is implemented

- Schema-first Effect v4 HTTP API using `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, tagged errors, services, Layers, and reusable managed runtimes.
- Cloudflare D1 persistence with atomic event and durable push-job batches.
- Named D1 query telemetry for duration, rows returned, rows read, and rows written, without SQL parameters or payload values. See [D1 query observability](docs/d1-observability.md).
- Project-scoped API keys. Only SHA-256 hashes are stored, and newly generated keys are shown once.
- Event ingestion with levels, source, type, fingerprint, external-id idempotency, structured context, recursive sensitive-key redaction, and bounded fields.
- Drop-in Sentry SDK ingestion through the modern envelope endpoint, with compressed bodies, Sentry grouping fingerprints, and the same event creation and notification pipeline.
- Up to three validated event actions, rendered in event details and encrypted Web Push notifications.
- Fingerprint grouping scoped to each project, including occurrence count, first seen, last seen, and occurrence drill-down.
- Cursor pagination and filters for project, level, source, fingerprint, search text, RFC 3339 time ranges, grouped state, and silenced state.
- PWA event export through plain-text copy, sectioned Markdown for coding/operations agents, and the Web Share API.
- Project CRUD, notification thresholds, enable/disable controls, API-key rotation, and test events.
- Encrypted standards-based Web Push using VAPID and `@pushforge/builder`, compatible with Cloudflare Workers.
- Installable PWA with an offline shell, push-subscription management, notification action buttons, tap-through, and iOS Home Screen guidance.
- Queue-first event acceptance, durable push jobs, leases, bounded Queue-owned retries, terminal dead-letter outcomes, and expired-subscription disabling.
- Silence rules by fingerprint, title, or source, including project-specific and global rules.
- Optional read-only MCP Streamable HTTP endpoint using the official `@modelcontextprotocol/server` TypeScript SDK.
- Cloudflare Access administrator identity, same-origin checks, retention settings, and optional daily retention.
- Static PWA assets served through Workers Static Assets.

The repository is production-oriented but remains pre-1.0. See [ROADMAP.md](ROADMAP.md) for remaining hardening work and [CHANGELOG.md](CHANGELOG.md) for release details.

## Architecture

```text
Apps, CI, cron jobs                      MCP clients / agents
        │                                        │
        │ POST /api/v1/events                    │ POST /mcp
        │ project bearer key                     │ read-only auth
        ▼                                        ▼
┌─────────────────────────────────────────────────────────┐
│ Cloudflare Worker                                       │
│                                                         │
│ Fetch boundary                                          │
│ Effect HttpApi + schemas + middleware                   │
│ Effect services + Layers + ManagedRuntime               │
│ Admin API + PWA API + official MCP TypeScript SDK       │
└───────────────────┬───────────────────────┬─────────────┘
                    │ IngestEvent
                    ▼
            ┌─────────────────┐
            │ Cloudflare Queue│── DeliverPush ──┐
            └────────┬────────┘                 │
                     ▼                          ▼
             ┌──────────────┐          Browser push services
             │ Cloudflare D1│          FCM / Mozilla / Apple
             │ events/jobs  │                   │
             └──────┬───────┘                   ▼
                    ▼                  Installed PWA notification
               PWA inbox
```

Cloudflare Queue is the durable acceptance boundary. The HTTP endpoint returns `202 Accepted` only after a schema-versioned `IngestEvent` command is accepted. Its consumer idempotently creates the event and jobs, then publishes `DeliverPush` commands before acknowledging. Queue redelivery resumes partial fan-out without a repair Cron. D1 owns delivery claims, attempt limits, and terminal `sent`/`dead` state; Queue owns retry timing. See [event ingestion](docs/event-ingestion.md) and [Web Push delivery lifecycle](docs/delivery.md).

MCP, HTTP, Queue consumption, and scheduled maintenance intentionally remain one
modular Worker deployment until production isolation or scaling evidence justifies the
extra operational boundary. See [ADR 0002](docs/decisions/0002-retain-single-worker-deployment.md)
for the measured bundle baseline, decision triggers, and requirements for a safe split.

## Requirements

- Node.js 22.12 or newer.
- pnpm.
- A Cloudflare account with Workers, D1, Queues, and a domain or `workers.dev` hostname.
- An HTTPS production origin. Browser push subscriptions require a secure context.

On iPhone and iPad, open the site in Safari, add it to the Home Screen, launch the installed PWA, and grant notification permission from a user gesture.

## Local setup

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm secrets -- --subject mailto:you@example.com
```

Copy the generated values into `.dev.vars`. Never commit `.dev.vars`.

Create local D1 state and apply all migrations:

```bash
pnpm exec wrangler d1 migrations apply ops-context --local
```

Build the PWA and launch the Worker:

```bash
pnpm build:web
pnpm dev
```

For frontend-only development with API proxying:

```bash
# terminal 1
pnpm dev

# terminal 2
pnpm dev:web
```

The PWA dev server is at `http://localhost:5173`; API requests are proxied to Wrangler at `http://localhost:8787`.

## Cloudflare provisioning

Create D1 and put the returned database id into `wrangler.jsonc`:

```bash
pnpm exec wrangler d1 create ops-context
```

Create the primary and dead-letter Queues:

```bash
pnpm exec wrangler queues create ops-context-push
pnpm exec wrangler queues create ops-context-push-dlq
```

Generate the VAPID keys:

```bash
pnpm secrets -- --subject mailto:you@example.com
```

Upload each generated value. Wrangler prompts for values without storing them in shell history:

```bash
pnpm exec wrangler secret put VAPID_PUBLIC_KEY
pnpm exec wrangler secret put VAPID_PRIVATE_JWK
pnpm exec wrangler secret put VAPID_SUBJECT
```

Configure the Cloudflare Access hostnames/audiences, `OPS_BASE_URL`, and default retention in `wrangler.jsonc`, then apply migrations and deploy:

```bash
pnpm exec wrangler d1 migrations apply ops-context --remote
pnpm deploy
```

## Install and enroll the PWA

1. Open the deployed origin and sign in.
2. Install the PWA. Chrome and Edge expose an install prompt. On iOS, use Safari → Share → **Add to Home Screen**.
3. Launch the installed application.
4. Select **Enable push** and approve notifications.
5. Go to **Projects**, create a project, and copy its API key.
6. Use **Test** on the project row to verify end-to-end Queue and Web Push delivery.

Every browser installation gets its own Web Push subscription and one-time, installation-scoped renewal credential. The raw credential stays in IndexedDB while only its hash is stored in D1. The dashboard can rename, disable, or remove subscriptions; disabling or removing one also revokes its renewal credential. See [PWA push-subscription renewal](docs/push-renewal.md).

## Send an event

```bash
curl https://ops.example.com/api/v1/events \
  -H "Authorization: Bearer ops_proj_REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Deploy completed",
    "body": "api@7d18b7f is serving production traffic",
    "level": "success",
    "source": "github-actions",
    "type": "deployment",
    "fingerprint": "production-api-deploy",
    "external_id": "github-run-12345",
    "data": {
      "environment": "production",
      "commit": "7d18b7f",
      "authorization": "this value is redacted before storage"
    },
    "actions": [
      {
        "label": "Open run",
        "url": "https://github.com/example/repository/actions/runs/12345"
      }
    ]
  }'
```

A successful Queue acceptance returns HTTP `202 Accepted`:

```json
{
  "id": "evt_...",
  "accepted_at": "2026-08-31T12:00:00.000Z",
  "status": "queued"
}
```

The event is eventually consistent: it may briefly return `404` from the administrator read API until the Queue consumer persists it. A Queue publication failure returns `503`, and the client should retry. Reusing `external_id` gives producer retries the same event id.

Levels are `info`, `success`, `warning`, `error`, and `critical`.

Actions are optional. An event may contain at most three actions; labels are limited to 40 characters, URLs must be absolute, and unsafe local/script schemes are refused.

The raw HTTP body is limited to **256 KiB**, and the normalized event is limited to **120,000 encoded bytes** so its versioned command remains below Cloudflare Queue's 128,000-byte message ceiling. Titles, bodies, identifiers, timestamps, actions, and structured context are validated by a shared Effect Schema contract; invalid values are rejected rather than truncated. See [the event ingestion contract](docs/event-ingestion.md) for every field and structural limit.

### Sentry SDKs — drop-in DSN

Ops Context accepts the Sentry envelope protocol, so an existing server-side Sentry SDK can report here without changing application code. Set the SDK DSN to the Ops Context origin and use a project API key as the DSN public key:

```text
SENTRY_DSN=https://ops_proj_REPLACE_ME@ops.example.com/1
```

The value before `@` is an Ops Context project key. The trailing project id is required by Sentry's DSN format but ignored; the key selects the project. The Worker accepts `POST /api/{id}/envelope/`, including gzip- and deflate-compressed envelopes.

> **Keep this DSN server-side.** Unlike a normal Sentry DSN, it contains a write-capable Ops Context project key. Do not embed it in browser, mobile, or other untrusted client code.

Exception events use `Type: value` titles, compact stack/context bodies, Sentry level mapping, `source: "sentry"`, and grouping fingerprints. Message events group on their unformatted templates. Curated context is stored in `data` and passes through the same redaction, silence, D1, durable push-job, and Queue pipeline as `/api/v1/events`. Transactions, sessions, attachments, and other non-error items are accepted and ignored.

See [docs/sentry.md](docs/sentry.md) for authentication, mapping, limits, and a raw envelope example.

### Shell helper

```bash
ops_event() {
  curl -fsS "$OPS_CONTEXT_URL/api/v1/events" \
    -H "Authorization: Bearer $OPS_CONTEXT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg title "$1" \
      --arg body "${2:-}" \
      --arg level "${3:-info}" \
      '{title:$title, body:$body, level:$level}')"
}

pg_dump app > backup.sql \
  && ops_event "Backup complete" "" success \
  || ops_event "Backup failed" "$(tail -n 1 backup.log)" error
```

## Inbox grouping and filters

Use the PWA’s **Group repeats** toggle, or call:

```http
GET /api/v1/events?grouped=true
```

Events with the same non-empty fingerprint are grouped only within their project. The latest occurrence represents the row and includes:

```json
{
  "group": {
    "count": 47,
    "first_seen": "2026-08-30T09:31:00.000Z",
    "last_seen": "2026-08-30T10:42:00.000Z"
  }
}
```

The default grouped inbox reads a measured project-scoped read model. Filters
that depend on individual occurrences automatically use the exact dynamic
query. See [Grouped inbox read model](docs/grouped-inbox-read-model.md) for the
measurements, retention behavior, and idempotent repair operation.

Supported event-list query parameters are:

```text
project, level, source, fingerprint, search,
since, until, grouped, silenced, before, limit
```

`since` and `until` use RFC 3339 timestamps and apply to `created_at`. All active filters are applied before fingerprint grouping.

## MCP for agents

The optional `/mcp` endpoint exposes these read-only tools:

```text
list_projects
list_events
search_events
get_event
get_event_group
```

Configure the MCP Cloudflare Access application and audience, then enable MCP from **Settings** in the PWA. Access user and service-token identities are accepted according to that policy; project ingestion keys are explicitly refused.

See [docs/mcp.md](docs/mcp.md) for transport details, authentication, and example requests.

## HTTP API

All JSON errors have the form:

```json
{ "error": "code", "message": "human-readable message" }
```

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| GET | `/health` | none | D1 health check |
| POST | `/api/v1/events` | project bearer key | Queue an event (`202 Accepted`) |
| POST | `/api/:id/envelope/` | Sentry DSN project key | Ingest Sentry SDK error envelopes |
| GET | `/api/v1/events` | administrator | List, search, filter, paginate, or group events |
| GET | `/api/v1/events/:id` | administrator | Read complete event context and actions |
| GET | `/api/v1/events/:id/deliveries` | administrator | Delivery attempts |
| POST | `/api/v1/events/:id/unsilence` | administrator | Clear silence and push |
| GET/POST | `/api/v1/projects` | administrator | List/create projects |
| GET/PATCH/DELETE | `/api/v1/projects/:id` | administrator | Manage project |
| POST | `/api/v1/projects/:id/rotate-key` | administrator | Rotate project key |
| GET | `/api/v1/push/public-key` | none | VAPID public key |
| GET/POST | `/api/v1/push/subscriptions` | administrator | List/enroll PWA installations |
| PATCH/DELETE | `/api/v1/push/subscriptions/:id` | administrator | Manage PWA installation |
| POST | `/api/v1/push/subscriptions/:id/renew` | installation renewal credential | Replace that installation's endpoint and rotate its credential |
| GET/POST | `/api/v1/silences` | administrator | List/create silence rules |
| GET/DELETE | `/api/v1/silences/:id` | administrator | Read/delete rule |
| GET/PATCH | `/api/v1/settings` | administrator | Retention, redaction, setup, and MCP enablement |
| GET | `/api/v1/status` | administrator | Deployment status and counts |
| POST | `/api/v1/test` | administrator | Create and push a test event |
| POST | `/mcp` | Cloudflare Access | Read-only MCP Streamable HTTP endpoint |

The generated OpenAPI document is available at:

```text
/api/v1/openapi.json
```

The Sentry compatibility route is handled at the Worker fetch boundary rather than by `HttpApi`, so it is documented here and in [docs/sentry.md](docs/sentry.md) instead of the generated OpenAPI document.

Administrator and MCP authentication use Cloudflare Access only. Project bearer keys are explicitly rejected on administrative and MCP routes.

## Effect v4 structure

The Worker boundary is a standard Cloudflare module handler. Inside that boundary:

- `HttpApi`, endpoint/group schemas, and `HttpApiMiddleware` define and validate the HTTP contract.
- Tagged domain and application errors are mapped to HTTP only by the API adapter; see [docs/errors.md](docs/errors.md).
- `Projects`, `Events`, `Subscriptions`, `Silences`, `Settings`, `EventIngestion`, `PushDelivery`, `Retention`, `McpEndpoint`, and `SentryEndpoint` are narrow Effect services.
- Live implementations are assembled through `Layer` composition in `worker/src/layers.ts`.
- `ManagedRuntime` builds the application graph once per Worker isolate and reuses it for Fetch, Queue, scheduled retention, MCP, and Sentry envelope executions.
- A narrow `Database` service uses native D1 results to preserve atomic batches and capture per-query row and duration metadata.
- Effect’s `Crypto.Crypto` capability generates and hashes high-entropy credentials. PBKDF2 remains isolated behind the password-hasher service, and Web Push cryptography remains behind the `WebPush` service.
- The official MCP TypeScript SDK is wrapped by an Effect service rather than leaking protocol/runtime concerns into domain logic.

Domain and application services expose typed Effect programs. Cloudflare bindings and Web APIs are supplied only through infrastructure Layers.

## Security model

- Project credentials are treated as high-entropy secrets and stored only as SHA-256 hashes.
- Sentry DSNs contain a write-capable project key and must stay in trusted server-side configuration.
- Cloudflare Access is the only production administrator and MCP identity provider.
- Browser administrative mutations are restricted to the configured same origin.
- MCP checks the request host/origin before protocol dispatch and receives only a validated read-only principal.
- Web Push payloads are encrypted according to the Web Push protocol before they are handed to browser push services.
- Event action URLs are validated on ingestion and rendered with safe external-link behavior in the PWA.
- Common secret-bearing object keys are recursively redacted before event context reaches D1. Operators can add custom keys.
- Queue consumers disable expired subscriptions after HTTP 404 or 410 responses.
- The API applies request-size and field-length limits.

Review [SECURITY.md](SECURITY.md) before exposing an instance publicly.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build:web
pnpm build:worker
```

The full check runs strict Worker/PWA type checks, Vitest, a production Vite build, and a Wrangler dry-run Worker bundle:

```bash
pnpm check
```

## License

MIT. See [LICENSE](LICENSE).
