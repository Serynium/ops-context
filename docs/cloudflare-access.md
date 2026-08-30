# Cloudflare Access administration

Ops Context delegates private-surface authentication to Cloudflare Access. The Worker does not maintain administrator passwords, Basic authentication, session cookies, or D1 administrator sessions.

## Trust boundary

Cloudflare validates the Access session or service token before the request reaches the application. The Worker then consumes the verified Access context exposed by the Workers runtime and copies only a minimal principal into internal request headers.

Caller-provided copies of those internal headers are always deleted before verification. The application also checks:

- the request hostname;
- the Access application audience (`aud`);
- the requested surface (`app` or `mcp`);
- whether the identity is a human user or a service token.

Project bearer keys remain valid only for public event ingestion and are rejected on private surfaces.

## Recommended hostnames

| Host | Access policy | Purpose |
|---|---|---|
| `ingest.ops.example.com` | Public network access | Event ingestion authenticated by project keys |
| `app.ops.example.com` | Human-user Access policy | PWA and administrator API |
| `mcp.ops.example.com` | Human and/or service-token Access policy | Read-only MCP endpoint |

Do not expose administrator or MCP routes through an unprotected `workers.dev` hostname. Disable the route for production or ensure it is not reachable outside an equivalent Access policy.

## Worker variables

Configure the following non-secret variables in `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "OPS_BASE_URL": "https://app.ops.example.com",
    "OPS_APP_HOST": "app.ops.example.com",
    "OPS_ACCESS_APP_AUD": "<APP_ACCESS_AUDIENCE>",
    "OPS_MCP_HOST": "mcp.ops.example.com",
    "OPS_ACCESS_MCP_AUD": "<MCP_ACCESS_AUDIENCE>",
    "OPS_RETENTION_DAYS": "90",
    "OPS_PUSH_MAX_ATTEMPTS": "6"
  }
}
```

The audience values come from the corresponding Access applications. Keep separate Access applications for the interactive PWA and MCP when their policies differ.

## Access policies

### Application/PWA

Create a self-hosted Access application for `app.ops.example.com/*` and allow only intended operators. Require your chosen identity provider and MFA policy. The interactive app accepts only a user identity containing an email address; service tokens are rejected.

### MCP

Create a second self-hosted Access application for `mcp.ops.example.com/mcp`. It may allow:

- interactive users; and/or
- Access service tokens for non-browser MCP clients.

MCP is still disabled by default in Ops Context settings. Both the Access policy and the application setting must allow the request.

### Public ingestion

Do not place the ingestion endpoint behind the interactive Access policy. Producers authenticate with a per-project bearer key:

```http
Authorization: Bearer ops_proj_...
```

The key grants event creation only. It cannot access the administrator API or MCP.

## Logout

The PWA sign-out control navigates to Cloudflare Access logout:

```text
/cdn-cgi/access/logout
```

There is no application logout endpoint or local session to delete.

## Local development and tests

Production does not have a password fallback. Unit tests use `AdministratorIdentity.testLayer` or a fake Workers Access context. For browser development, use an Access-protected preview hostname or Miniflare/Workers test bindings that supply a test identity.

Never implement a production bypass based only on caller-provided `Cf-Access-*`, email, or internal identity headers.

## Migration

Apply migration `0005_remove_admin_sessions.sql` before deploying the Access-only Worker:

```bash
pnpm exec wrangler d1 migrations apply ops-context --remote
```

The migration drops the old `admin_sessions` table and invalidates every application session. Existing users must authenticate through Cloudflare Access after deployment.

## PWA renewal dependency

Issue #16 adds a narrowly scoped credential for background push-subscription renewal. Do not deploy the Access-only release until that credential is available, because a service worker cannot depend on an interactive browser Access session being active during background renewal.
