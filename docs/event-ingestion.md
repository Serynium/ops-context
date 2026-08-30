# Event ingestion contract

`POST /api/v1/events` accepts a JSON object authenticated with a project bearer key. The contract is defined once with Effect Schema and is reused by the HTTP API and the application service, including Sentry-mapped events.

Ops Context rejects invalid values; it does not silently truncate identifiers, fingerprints, timestamps, or message text.

## Queue-first acceptance

The endpoint authenticates the project, validates and normalizes the payload, assigns the event id and acceptance timestamp, and sends a versioned `IngestEvent` command. The command contains the complete normalized event and project id, but never the project key, an Access assertion, or another reusable credential.

Only a successful Queue send produces `202 Accepted`:

```json
{ "id": "evt_...", "accepted_at": "2026-08-31T12:00:00.000Z", "status": "queued" }
```

The event can be briefly absent from D1 after this response. Consumers should tolerate that eventual-consistency window. A Queue send failure returns `503 Service Unavailable` and does not claim acceptance.

Queue delivery is at least once. The consumer uses the event id, the unique `(project_id, external_id)` index, and the `(event_id, subscription_id)` job key to make duplicate ingestion harmless. With `external_id`, producer retries deterministically receive the same event id. The consumer publishes and marks each delivery job separately; if it crashes mid-fan-out, Queue redelivery publishes only remaining pending jobs. A crash after a downstream send but before its D1 update may produce a duplicate `DeliverPush` command, which the conditional delivery claim safely ignores.

## D1 lookup budget

The `IngestEvent` consumer loads the four required application settings with one `settings.load` query. Silence evaluation removes empty fingerprint, title, and source candidates, then matches every remaining candidate with one ordered `silences.match` query. Candidate order remains fingerprint, title, then source; a project-specific rule wins when both project and global rules match the same candidate.

No isolate-local settings cache is used. Each accepted command reads D1, so setting updates are authoritative immediately and isolate eviction has no cache-consistency effect.

Both consolidated queries emit a structured `d1_query` log containing the stable `query` name, `duration_ms`, `rows_returned`, and D1's `rows_read` and `rows_written` metadata. SQL parameters and event content are not logged. These fields support before/after comparison in Cloudflare Logs; the cold-path lookup budget changes from four settings queries plus up to three silence queries to one settings query plus at most one silence query.

## Request limit

The raw HTTP request body must be at most **262,144 bytes (256 KiB)**. The Worker checks the declared `Content-Length` when present. It also reads request streams incrementally and cancels both stream branches as soon as the measured body crosses the limit, so chunked requests cannot bypass the ceiling or force the isolate to buffer the complete body.

An oversized body returns:

```http
HTTP/1.1 413 Payload Too Large
Content-Type: application/json
```

```json
{
  "error": "payload_too_large",
  "message": "event request body must not exceed 262144 bytes"
}
```

## Field limits

| Field | Requirement |
|---|---|
| `title` | Required, trimmed, 1–240 characters |
| `body` | Optional, trimmed, up to 8,000 characters |
| `source` | Optional, trimmed, up to 160 characters |
| `type` | Optional, trimmed, up to 160 characters |
| `fingerprint` | Optional, trimmed, up to 500 characters |
| `external_id` | Optional; when supplied, trimmed and 1–500 characters |
| `level` | `info`, `success`, `warning`, `error`, or `critical` |
| `occurred_at` | Optional calendar-valid RFC 3339 timestamp with `Z` or a numeric offset |
| `actions` | Optional array containing at most three actions |
| `data` | Optional JSON object with the structural limits below |

`occurred_at` values are normalized to UTC before storage. Invalid dates such as `2026-02-30T10:00:00Z` and timestamps without an explicit timezone are rejected.

## Actions

Each action contains:

```json
{
  "label": "Open workflow",
  "url": "https://github.com/example/repository/actions/runs/12345"
}
```

Constraints:

- label: 1–40 trimmed characters;
- URL: absolute HTTP or HTTPS URL, at most 2,048 characters;
- at most three actions per event.

Other schemes, including `javascript:`, `data:`, `file:`, and `ftp:`, are rejected.

## Structured data

`data` must be a JSON object. It may contain strings, finite numbers, booleans, nulls, arrays, and nested objects subject to these limits:

- maximum nesting depth: 12;
- maximum properties per object: 200;
- maximum items per array: 100.

Functions, symbols, `undefined`, non-finite numbers, class instances, and circular references are rejected at internal application boundaries. HTTP JSON decoding naturally excludes most of those values, but the application service validates them as well so protocol adapters cannot bypass the contract.

## Validation response

Application-level schema failures use a stable 422 response with field paths:

```json
{
  "error": "validation_error",
  "message": "event payload failed validation",
  "issues": [
    {
      "path": ["fingerprint"],
      "message": "Event fingerprint must contain at most 500 characters"
    }
  ]
}
```

The endpoint keeps the refined Effect Schema for OpenAPI and generated clients, but the server handler reads JSON explicitly and applies the contract inside the application error channel. This ensures field-level failures such as an overlong title or unsafe action URL are encoded through the declared 422 response instead of the framework's generic transport decode error. Malformed JSON is returned as the declared 400 response.
