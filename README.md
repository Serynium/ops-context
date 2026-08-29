# Ops Context

A tiny operational event inbox with encrypted PWA push notifications.

Ops Context is the Cloudflare + Effect v4 interpretation of the same idea behind Boop: your software posts an event, it is stored in a clean inbox, and the devices you enrolled receive a native notification. There is no Slack workspace, Telegram bot, mobile app binary, or always-running server.

## What is implemented

- Effect v4 services and typed error channels around Cloudflare D1, Queues, configuration, authentication, event ingestion, and delivery.
- Project-scoped API keys. Only SHA-256 hashes are stored, and newly generated keys are shown once.
- Event ingestion with levels, source, type, fingerprint, arbitrary structured context, recursive sensitive-key redaction, truncation, and optional external-id idempotency.
- Event list/detail APIs with cursor pagination and filters.
- Project CRUD, notification thresholds, enable/disable controls, API-key rotation, and test events.
- Encrypted standards-based Web Push using VAPID and `@pushforge/builder`, compatible with Cloudflare Workers.
- Installable PWA with a service worker, offline shell, push subscription management, notification click-through, and iOS Home Screen guidance.
- Durable push jobs, Cloudflare Queue fan-out, leases, per-attempt delivery records, transient retries, dead-subscription disabling, and Cron recovery.
- Silence rules by fingerprint, title, or source, including project-specific and global rules.
- D1-backed administrator sessions, same-origin checks, PBKDF2 password verification, secure cookies, retention settings, and scheduled cleanup.
- Static PWA assets served through Workers Static Assets.

The repository is an initial production-oriented implementation, not a finished 1.0 release. See [ROADMAP.md](ROADMAP.md) for the remaining hardening work.

## Architecture

```text
Apps, CI, cron jobs
        │
        │ POST /api/v1/events + project key
        ▼
┌─────────────────────────────────────────────┐
│ Cloudflare Worker                           │
│                                             │
│ Native Fetch boundary                       │
│ Effect v4 services, effects, typed failures │
│ Admin API + PWA API                         │
└──────────────┬─────────────────┬────────────┘
               │                 │
               ▼                 ▼
       ┌──────────────┐   ┌────────────────┐
       │ Cloudflare D1│   │ Cloudflare Queue│
       │ events/jobs  │   │ push fan-out    │
       └──────┬───────┘   └───────┬────────┘
              │                   │
              │                   ▼
              │           Browser push services
              │           FCM / Mozilla / Apple
              │                   │
              ▼                   ▼
       PWA inbox          Installed PWA notification
```

The event write and creation of durable `push_jobs` rows happen in one D1 batch. Publishing to Queues is necessarily a second step, so the five-minute Cron Trigger republishes stale or never-published jobs. Queue consumers use a D1 lease and terminal job states to make at-least-once delivery safe. The Web Push `Topic` is derived from the event id so a push service can replace a duplicate that is still pending.

## Requirements

- Node.js 22.12 or newer.
- pnpm.
- A Cloudflare account with Workers, D1, Queues, and a domain or `workers.dev` hostname.
- An HTTPS origin. Push subscriptions do not work on an insecure production origin.

For iPhone and iPad, users must open the site in Safari, add it to the Home Screen, launch the installed PWA, and grant notification permission from a user gesture.

## Local setup

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm secrets -- --subject mailto:you@example.com
```

Copy the generated values into `.dev.vars`. Never commit `.dev.vars`.

Create local D1 state and run migrations:

```bash
pnpm exec wrangler d1 migrations apply ops-context --local
```

Build the PWA, then launch the Worker:

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

Generate the password hash and VAPID keys:

```bash
pnpm secrets -- --subject mailto:you@example.com
```

Upload each generated value. Wrangler prompts for the value without storing it in shell history:

```bash
pnpm exec wrangler secret put ADMIN_PASSWORD_HASH
pnpm exec wrangler secret put VAPID_PUBLIC_KEY
pnpm exec wrangler secret put VAPID_PRIVATE_JWK
pnpm exec wrangler secret put VAPID_SUBJECT
```

Set `OPS_ADMIN_USER`, `OPS_BASE_URL`, and the default retention in `wrangler.jsonc`, then apply migrations and deploy:

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
6. Use **Send test** to verify end-to-end Queue and Web Push delivery.

Every browser installation gets its own Web Push subscription. The dashboard can rename, disable, or remove subscriptions.

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
    }
  }'
```

A successful request returns:

```json
{
  "id": "evt_...",
  "created_at": "2026-08-29T12:00:00.000Z"
}
```

Levels are `info`, `success`, `warning`, `error`, and `critical`.

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

## HTTP API

All JSON errors have the form:

```json
{ "error": "code", "message": "human-readable message" }
```

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| GET | `/health` | none | D1 health check |
| POST | `/api/v1/events` | project bearer key | Create an event |
| GET | `/api/v1/events` | administrator | List/filter events |
| GET | `/api/v1/events/:id` | administrator | Read event context |
| GET | `/api/v1/events/:id/deliveries` | administrator | Delivery attempts |
| POST | `/api/v1/events/:id/unsilence` | administrator | Clear silence and push |
| GET/POST | `/api/v1/projects` | administrator | List/create projects |
| GET/PATCH/DELETE | `/api/v1/projects/:id` | administrator | Manage project |
| POST | `/api/v1/projects/:id/rotate-key` | administrator | Rotate project key |
| GET | `/api/v1/push/public-key` | none | VAPID public key |
| GET/POST | `/api/v1/push/subscriptions` | administrator | List/enroll PWA installs |
| PATCH/DELETE | `/api/v1/push/subscriptions/:id` | administrator | Manage PWA install |
| GET/POST | `/api/v1/silences` | administrator | List/create silence rules |
| GET/DELETE | `/api/v1/silences/:id` | administrator | Read/delete rule |
| GET/PATCH | `/api/v1/settings` | administrator | Retention and redaction |
| GET | `/api/v1/status` | administrator | Deployment status and counts |
| POST | `/api/v1/test` | administrator | Create and push a test event |

Administrator authentication accepts the secure session cookie created by the PWA or HTTP Basic credentials. Project bearer keys are explicitly rejected on administrative routes.

## Effect v4 structure

The Worker boundary remains a standard Cloudflare module handler. Inside it, application code depends on Effect services:

- `Database`: D1 queries, writes, and atomic batches.
- `AppConfig`: validated Worker configuration and secrets.
- `PushQueue`: Queue publishing.

Domain modules return `Effect.Effect<A, AppError, Services>` values rather than throwing through normal control flow. The entrypoint supplies the live services per invocation and translates typed failures to the stable JSON error contract.

The code deliberately keeps the D1 binding behind an application service rather than coupling every domain module to Cloudflare globals. This also keeps room for a local SQLite or Durable Object implementation later.

## Security model

- Project and session credentials are stored only as SHA-256 hashes.
- The administrator password is stored as a PBKDF2-SHA-256 hash with a per-installation salt and at least 310,000 iterations.
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS.
- Browser administrative mutations are restricted to the same origin.
- Web Push payloads are encrypted according to the standard Web Push protocol before they are handed to browser push services.
- Common secret-bearing object keys are recursively redacted before event context reaches D1. Operators can add custom keys.
- Queue consumers disable expired subscriptions after HTTP 404 or 410 responses.
- The API applies request-size and field-length limits.

Review [SECURITY.md](SECURITY.md) before exposing an instance publicly.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build:web
```

The current tests cover pure domain behavior. Worker-runtime integration and D1/Queue contract tests are listed in the roadmap.

## License

MIT. See [LICENSE](LICENSE).
