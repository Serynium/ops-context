# Sentry SDK ingestion

Flarebox accepts error events from server-side Sentry SDKs through Sentry's envelope transport. Existing applications can keep their Sentry integration and change only the DSN.

## Configure the DSN

Use the Flarebox origin as the DSN host. Sentry SDKs restrict DSN public keys
to word characters, so hex-encode the complete project API key and prefix it
with `ops_sentry_`:

```text
SENTRY_DSN=https://ops_sentry_HEX_ENCODED_PROJECT_KEY@flarebox.example.com/1
```

The Worker decodes the DSN key before normal project-key authentication. The
trailing project id is required by the Sentry DSN format but is ignored.

> Keep this DSN server-side. A normal Sentry DSN public key is designed to be public, but this DSN contains a write-capable Flarebox project API key. Do not embed it in browser bundles, mobile applications, or other untrusted clients.

Most SDKs read `SENTRY_DSN` directly. SDK-specific configuration can use the same DSN string.

## Endpoint and authentication

SDK envelopes are sent to:

```http
POST /api/{project-id}/envelope/
```

The route must end at `envelope/`; additional path segments do not match. Authentication accepts the Sentry `sentry_key` from either:

- the `X-Sentry-Auth` header; or
- the `sentry_key` query parameter.

The key is authenticated through the existing project-key service. The path project id is not used for authorization or project selection.

The Worker accepts identity, gzip, and deflate request bodies. It limits the request to 2 MiB on the wire and 16 MiB after decompression. Unsupported encodings return `415`, oversized bodies return `413`, and missing or invalid project keys return `401`. If any valid event cannot reach the durable Queue because Queue, D1, or cryptography infrastructure is temporarily unavailable, the envelope returns retryable `503 Service Unavailable` with `Retry-After: 5`; already accepted items are safe to receive again because Sentry event IDs drive idempotency.

## Event mapping

Each Sentry `event` envelope item becomes a normal Flarebox event and enters the same Queue-first pipeline as `POST /api/v1/events`. Envelope acceptance therefore precedes eventual D1 visibility; the `IngestEvent` consumer preserves recursive redaction, silence matching, fingerprint grouping, durable push jobs, notification thresholds, and Queue delivery.

| Sentry field | Flarebox field |
|---|---|
| exception type and value | one-line `title`, such as `ValueError: invalid card` |
| formatted message | message-event `title` |
| culprit/transaction, top frame, environment/release/server | compact `body` |
| `fatal` | `critical` |
| `error` | `error` |
| `warning` | `warning` |
| `info` or `debug` | `info` |
| Sentry event id | `external_id` for idempotency |
| platform, tags, SDK, and recent exception frames | structured `data` |

The event source is `sentry`, and the type is `exception` or `message`.

Explicit Sentry fingerprints are preserved after removing the `{{ default }}` placeholder. Otherwise, exception fingerprints use the exception type and top in-app stack frame. Message fingerprints use the unformatted message template, so interpolated messages such as `user 1 failed` and `user 2 failed` remain in the same group.

Transactions, sessions, attachments, and other non-error item types are accepted and ignored. The legacy Sentry `/store/` endpoint is not implemented.

## Minimal envelope example

This request demonstrates the transport without installing an SDK:

```bash
body='{"event_id":"0123456789abcdef0123456789abcdef"}
{"type":"event"}
{"event_id":"0123456789abcdef0123456789abcdef","level":"error","message":"checkout failed"}'

curl -i https://flarebox.example.com/api/1/envelope/ \
  -H 'Content-Type: application/x-sentry-envelope' \
  -H 'X-Sentry-Auth: Sentry sentry_version=7,sentry_key=ops_proj_REPLACE_ME' \
  --data-binary "$body"
```

A successful response is:

```json
{ "id": "0123456789abcdef0123456789abcdef" }
```

An envelope containing no usable `event` item still returns `200` with an empty id, matching SDK expectations for ignored item types.
