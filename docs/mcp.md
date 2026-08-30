# Model Context Protocol

Ops Context exposes an optional read-only MCP endpoint at:

```text
https://your-ops-context.example/mcp
```

The transport is stateless MCP Streamable HTTP. Send JSON-RPC requests with `POST`; the server responds with JSON and does not require an MCP session id.

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

Project API keys are explicitly refused, so an event-ingestion credential never gains read access.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_projects` | List all projects. |
| `list_events` | List events with project, level, source, fingerprint, time, silence, and grouping filters. |
| `search_events` | Search titles, bodies, sources, fingerprints, and structured context. |
| `get_event` | Retrieve one event by id. |
| `get_event_group` | Retrieve occurrences for a project and fingerprint. |

All tools are read-only. MCP cannot create, mutate, unsilence, or delete operational data.

## Example initialization

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
