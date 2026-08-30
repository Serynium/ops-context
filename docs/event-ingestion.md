# Event ingestion contract

`POST /api/v1/events` accepts a JSON object authenticated with a project bearer key. The contract is defined once with Effect Schema and is reused by the HTTP API and the application service, including Sentry-mapped events.

Ops Context rejects invalid values; it does not silently truncate identifiers, fingerprints, timestamps, or message text.

## Request limit

The raw HTTP request body must be at most **262,144 bytes (256 KiB)**. The Worker checks the declared `Content-Length` when present and also measures a cloned request body so chunked requests cannot bypass the limit.

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
| `external_id` | Optional, trimmed, up to 500 characters |
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

Application-level schema failures use a stable 422 response with optional field paths:

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

Malformed JSON and transport-level decoding failures may be returned as a typed 400 response by the Effect HTTP boundary.
