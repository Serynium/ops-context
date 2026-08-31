# ADR 0004: Retain one Worker with verified Access JWT fallback

## Status

Accepted.

## Context

Ops Context deploys the PWA through Workers Static Assets and routes `/api/*`,
`/health`, and `/mcp` through the Worker. Cloudflare Access can expose a
validated identity through `ctx.access` when a request invokes a Worker
directly. The Static Assets router does not always forward that runtime context,
but it does forward the signed Access assertion.

Splitting static assets and API execution into separate Worker deployments would
restore direct `ctx.access`, but it would also add deployment coordination,
bindings, routing, and rollback complexity without a measured bundle or scaling
need.

## Decision

Retain one Worker deployment.

- Use `ctx.access` as the fast path.
- When it is absent on an app or MCP surface, verify
  `Cf-Access-Jwt-Assertion` against the configured Access team JWKS.
- Require RS256, exact issuer, surface-specific audience, application token
  type, and valid temporal claims.
- Cache the remote JWKS resolver per isolate and permit normal certificate
  overlap.
- Strip assertion and internal identity headers before the Effect HTTP
  application sees the request.
- Fail closed when the team domain, audience, key, signature, or claims are
  invalid.

## Consequences

- Static assets, API, MCP, Queue, DLQ, and retention keep one release unit.
- Access verification adds one zero-dependency JOSE library and an occasional
  JWKS fetch after isolate startup or key rotation.
- Private requests continue to work through the Static Assets router.
- A future Worker split remains justified only by measured CPU/startup,
  independent ownership, security policy, or fault-isolation requirements.
