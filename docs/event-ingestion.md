# Event ingestion contract

`POST /api/v1/events` accepts a JSON object authenticated with a project bearer key. The contract is defined once with Effect Schema and is reused by the HTTP API and the application service, including Sentry-mapped events.

Ops Context rejects invalid values; it does not silently truncate identifiers, fingerprints, timestamps, or message text.

## Queue-first acceptance

The endpoint authenticates the project, validates and normalizes the payload, recursively redacts default and operator-configured sensitive keys, assigns the event id and acceptance timestamp, and sends a versioned `IngestEvent` command. The command contains the complete redacted event and project id, but never the project key, an Access assertion, or another reusable credential. The consumer redacts again before D1 persistence so a setting tightened after acceptance is also honored.

Only a successful Queue send produces `202 Accepted`:

```json
{ "id": "evt_...", "accepted_at": "2026-08-31T12:00:00.000Z", "status": "queued" }
```

The event can be briefly absent from D1 after this response. Consumers should tolerate that eventual-consistency window. A Queue send failure returns `503 Service Unavailable` and does not claim acceptance.

Queue delivery is at least once. The consumer uses the event id, the unique `(project_id, external_id)` index, and the `(event_id, subscription_id)` job key to make duplicate ingestion harmless. With `external_id`, producer retries deterministically receive the same event id. Event/job initialization and its `fanout_completed_at` marker commit in one D1 batch, so a duplicate command cannot add jobs for subscriptions enrolled later. The consumer publishes and marks each delivery job separately; if it crashes mid-fan-out, Queue redelivery publishes only remaining pending jobs. A crash after a downstream send but before its D1 update may produce a duplicate `DeliverPush` command, which the conditional delivery claim safely ignores.

During rollout, the decoder also accepts the previous untagged `{ eventId, subscriptionId }` delivery shape and normalizes it to version 1. If an `IngestEvent` reaches the dead-letter Queue, the consumer first attempts to finish it. A persistent failure is recorded in `ingestion_failures`, any still-pending jobs become terminal `dead`, and the administrator status count exposes `failed_ingests`. If D1 itself is unavailable, the DLQ message is retried because no terminal record can yet be made safely.

## D1 lookup budget

For events with structured `data`, the HTTP acceptance path loads the four required application settings with one `settings.load` query so secrets are redacted before the durable Queue write. The `IngestEvent` consumer loads the settings again before persistence. Silence evaluation removes empty fingerprint, title, and source candidates, then matches every remaining candidate with one ordered `silences.match` query. Candidate order remains fingerprint, title, then source; a project-specific rule wins when both project and global rules match the same candidate.

No isolate-local settings cache is used. The acceptance and consumer reads make setting updates authoritative immediately and avoid cache-consistency dependence on isolate lifetime.

Both consolidated queries emit a structured `d1_query` log containing the stable `query` name, `duration_ms`, `rows_returned`, and D1's `rows_read` and `rows_written` metadata. SQL parameters and event content are not logged. These fields support before/after comparison in Cloudflare Logs; the cold-path lookup budget changes from four settings queries plus up to three silence queries to one settings query plus at most one silence query.

## Request limit

The raw HTTP request body must be at most **262,144 bytes (256 KiB)**. The Worker checks the declared `Content-Length` when present. It also reads request streams incrementally and cancels both stream branches as soon as the measured body crosses the limit, so chunked requests cannot bypass the ceiling or force the isolate to buffer the complete body.

After JSON decoding and normalization, the encoded event must be at most **120,000 bytes**. This leaves room for the versioned command envelope and Cloudflare's internal metadata under the Queue platform's 128,000-byte per-message limit. Inputs over this application limit fail validation before Queue publication, so retrying an intrinsically oversized event cannot produce a misleading transient `503`.

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
