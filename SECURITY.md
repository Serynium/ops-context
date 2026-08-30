# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability involving authentication bypass, credential exposure, Web Push encryption, D1 data access, or event redaction. Contact the repository owner privately and include reproduction steps, affected routes, expected impact, and any proposed mitigation.

## Authentication boundaries

Ops Context has two intentionally separate credential classes.

### Project ingestion keys

Project keys are high-entropy bearer credentials shown once and stored only as SHA-256 digests. They authorize event ingestion for one project and nothing else.

They must not authorize:

- the PWA or administrator API;
- settings, project management, or push-device management;
- MCP tools.

### Cloudflare Access identities

The PWA, administrator API, and MCP are protected by Cloudflare Access. The Worker consumes the verified native Access context and validates the configured hostname, audience, surface, and principal type.

The application does not maintain administrator passwords, HTTP Basic authentication, local login endpoints, session cookies, or D1 administrator sessions.

Caller-provided identity headers are removed before the native Access context is translated into the internal request principal. Do not reintroduce a production fallback that trusts `Cf-Access-*`, email, or internal headers without runtime verification.

See [docs/cloudflare-access.md](docs/cloudflare-access.md).

## Hostname isolation

Use separate hosts:

```text
ingest.ops.example.com  public event ingestion with project keys
app.ops.example.com     Access-protected PWA and administrator API
mcp.ops.example.com     Access-protected MCP endpoint
```

Disable or equivalently protect the production `workers.dev` route so it cannot bypass the Access applications.

## Secrets

Keep these only in Wrangler secrets or an equivalent secure secret store:

```text
VAPID_PRIVATE_JWK
VAPID_PUBLIC_KEY
VAPID_SUBJECT
```

Cloudflare Access service-token secrets belong in the MCP client or deployment secret store, not in Ops Context application settings or source control.

Do not commit project API keys, D1 exports containing operational data, push-subscription encryption keys, Access service-token secrets, or generated `.dev.vars` files.

## Web Push

Web Push payloads are encrypted per subscription and signed through VAPID by `@pushforge/builder`. Treat subscription endpoints and their `p256dh`/`auth` values as sensitive credentials. Expired or permanently rejected subscriptions are disabled.

PWA renewal credentials are installation-scoped bearer credentials stored raw only in same-origin IndexedDB; D1 stores their SHA-256 hashes. They can replace only the matching push-subscription row, rotate after every successful renewal, and are revoked when that row is disabled or removed. They never authorize administration, ingestion, or MCP. See [PWA push-subscription renewal](docs/push-renewal.md).

## Data handling

Ops Context applies recursive sensitive-key redaction before storing event context. Redaction is defense in depth, not a substitute for avoiding secrets in event payloads.

Use least-privilege project keys, configure retention, and review custom redaction keys. Action URLs are displayed to operators and must not contain reusable credentials.

## Supported versions

This project is under active development. Security fixes are applied to the latest `main` branch and latest tagged release only.
