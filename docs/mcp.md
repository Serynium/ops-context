# Read-only MCP endpoint

Ops Context exposes an optional Model Context Protocol endpoint at:

```text
https://mcp.ops.example.com/mcp
```

It uses Streamable HTTP through the official `@modelcontextprotocol/server` TypeScript SDK. The MCP adapter is wrapped by an Effect service and reuses the same project, event, settings, and D1 capabilities as the HTTP API.

## Enablement

MCP is disabled by default. Enable it from **Settings → Enable read-only MCP endpoint**.

The status response reports:

```json
{
  "mcp_enabled": true,
  "mcp_access_configured": true
}
```

## Authentication

MCP is protected only by Cloudflare Access.

Use a dedicated Access application for the MCP hostname and configure:

```text
OPS_MCP_HOST=mcp.ops.example.com
OPS_ACCESS_MCP_AUD=<MCP_ACCESS_AUDIENCE>
```

The policy may accept:

- a human Access identity; or
- a Cloudflare Access service token for an automated MCP client.

The Worker verifies the native Access context, hostname, audience, and requested surface. It does not trust caller-provided identity headers.

Project ingestion keys are explicitly rejected. They grant write-only event ingestion and are not administrator or MCP credentials.

The previous `OPS_MCP_TOKEN`, HTTP Basic authentication, and administrator-session cookie paths have been removed.

See [Cloudflare Access administration](cloudflare-access.md) for the complete hostname and policy design.

## Tools

### `list_projects`

Lists projects with identifiers, slugs, notification settings, and metadata.

### `list_events`

Lists recent events newest first. Filters include:

- project ID or slug;
- level;
- source;
- fingerprint;
- `since` and `until` RFC 3339 timestamps;
- silenced state;
- grouped or individual occurrences;
- cursor and limit.

### `search_events`

Searches titles, bodies, sources, fingerprints, and structured event data while accepting the same filters as `list_events`.

### `get_event`

Returns one event with complete structured context, actions, project metadata, and silence state.

### `get_event_group`

Returns aggregate metadata, the latest event, and paginated individual occurrences for a project/fingerprint pair.

All tools are annotated as read-only and idempotent.

## Client configuration

For an interactive client, open the MCP hostname and complete the Access login flow according to the client’s HTTP-authentication support.

For a headless client, configure an Access service token and send the Cloudflare Access service-token headers required by your policy. Do not place those values in the MCP JSON payload or source control.

Conceptual configuration:

```json
{
  "mcpServers": {
    "ops-context": {
      "type": "streamable-http",
      "url": "https://mcp.ops.example.com/mcp",
      "headers": {
        "CF-Access-Client-Id": "${OPS_CONTEXT_ACCESS_CLIENT_ID}",
        "CF-Access-Client-Secret": "${OPS_CONTEXT_ACCESS_CLIENT_SECRET}"
      }
    }
  }
}
```

Use the exact environment-variable and header configuration supported by your MCP client.

## Security behavior

The endpoint:

- accepts only `POST` and preflight `OPTIONS`;
- requires the configured MCP hostname;
- validates the MCP Access audience;
- accepts users or service tokens according to the Access policy;
- rejects project bearer keys;
- returns no-store, `nosniff`, and same-origin referrer headers;
- exposes read-only tools only.

The Access application should block requests before Worker execution when possible. The Worker checks the trusted native Access context again to keep the application boundary explicit and testable.
