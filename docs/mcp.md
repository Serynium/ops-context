# Model Context Protocol

Ops Context exposes an optional read-only MCP endpoint at:

```text
https://your-ops-context.example/mcp
```

The endpoint is implemented with the official `@modelcontextprotocol/server` TypeScript SDK and served directly through the Cloudflare Worker `Request`/`Response` boundary. It supports the current per-request MCP transport and the SDK's stateless 2025 Streamable HTTP fallback. Modern exchanges use JSON; compatible legacy clients may receive an SSE response, so clients should advertise both media types.

No durable MCP session state is stored in a Worker isolate. Every tool reads authoritative state from D1 through the existing Effect services.

## Enable it

Generate or upload a high-entropy bearer token:

```bash
pnpm secrets
pnpm exec wrangler secret put OPS_MCP_TOKEN
```

Then enable **Settings → Read-only MCP endpoint** in the PWA. `GET /api/v1/settings` reports both `mcp_enabled` and `mcp_token_set` without exposing the token.

The token must contain at least 16 characters. The generated value contains 256 bits of entropy.

## Authentication

The endpoint accepts one of:

- `Authorization: Bearer <OPS_MCP_TOKEN>`
- an active Ops Context administrator session cookie
- the configured administrator HTTP Basic credentials

Project API keys are explicitly detected and refused, so an event-ingestion credential never gains read access. Authenticated requests are forwarded to the official SDK with a validated read-only principal and the `events:read` scope.

Requests carrying an `Origin` must be same-origin, and the request host must agree with the Worker URL before protocol handling begins.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_projects` | List all projects. |
| `list_events` | List events with project, level, source, fingerprint, time, silence, cursor, and grouping filters. |
| `search_events` | Search titles, bodies, sources, fingerprints, and structured context. |
| `get_event` | Retrieve one event, including structured context and actions. |
| `get_event_group` | Retrieve aggregate metadata, the latest event, and paginated occurrences for a project and fingerprint. |

All tools advertise read-only, idempotent, closed-world annotations. MCP cannot create, mutate, unsilence, or delete operational data.

## Example initialization

This request uses the SDK's stateless 2025 compatibility path. Current SDK clients negotiate the latest protocol automatically.

```bash
curl https://your-ops-context.example/mcp \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "1" }
    }
  }'
```

## Example tool call

```bash
curl https://your-ops-context.example/mcp \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "search_events",
      "arguments": {
        "query": "timeout",
        "level": "error",
        "grouped": true,
        "limit": 25
      }
    }
  }'
```

The Worker deliberately does not cache `/mcp` responses, and the endpoint is routed through Worker code before Static Assets.