import { describe, expect, it } from "vitest"
import {
  SENTRY_MAX_COMPRESSED_BYTES,
  isSentryEnvelopePath,
  mapSentryEvent,
  readSentryBody,
  sentryKey,
  sentryLevel,
  splitSentryEnvelope
} from "../src/sentry.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

const envelope = (
  eventId: string,
  event: unknown,
  type = "event"
): Uint8Array => {
  const payload = encoder.encode(JSON.stringify(event))
  return concat(
    encoder.encode(`${JSON.stringify({ event_id: eventId })}\n`),
    encoder.encode(`${JSON.stringify({ type, length: payload.byteLength })}\n`),
    payload,
    encoder.encode("\n")
  )
}

const gzip = async (body: Uint8Array): Promise<ArrayBuffer> => {
  const input = new ReadableStream<BufferSource>({
    start(controller) {
      const buffer = new ArrayBuffer(body.byteLength)
      new Uint8Array(buffer).set(body)
      controller.enqueue(buffer)
      controller.close()
    }
  })
  const compressed = input.pipeThrough(new CompressionStream("gzip"))
  return await new Response(compressed).arrayBuffer()
}

describe("Sentry envelope ingestion", () => {
  it("matches only the exact Sentry envelope route", () => {
    expect(isSentryEnvelopePath("/api/1/envelope/")).toBe(true)
    expect(isSentryEnvelopePath("/api/abc/envelope/")).toBe(true)
    expect(isSentryEnvelopePath("/api/1/envelope")).toBe(false)
    expect(isSentryEnvelopePath("/api/1/envelope/anything/else")).toBe(false)
  })

  it("extracts the DSN key from the auth header or query string", () => {
    const header = new Request("https://ops.example.com/api/1/envelope/", {
      headers: {
        "X-Sentry-Auth": "Sentry sentry_version=7,sentry_client=test/1.0,sentry_key=ops_proj_header"
      }
    })
    const query = new Request("https://ops.example.com/api/1/envelope/?sentry_key=ops_proj_query")
    expect(sentryKey(header)).toBe("ops_proj_header")
    expect(sentryKey(query)).toBe("ops_proj_query")
  })

  it("parses byte-counted envelope items without breaking Unicode payloads", () => {
    const body = envelope("abc", { event_id: "abc", message: "déjà vu" })
    const items = splitSentryEnvelope(body)
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe("event")
    expect(JSON.parse(decoder.decode(items[0]?.payload))).toMatchObject({ message: "déjà vu" })
  })

  it("maps exceptions into grouped operational events", () => {
    const mapped = mapSentryEvent(encoder.encode(JSON.stringify({
      event_id: "abc123de-f456-7890-abcd-ef1234567890",
      level: "error",
      platform: "python",
      environment: "production",
      release: "1.4.2",
      culprit: "views.checkout in charge",
      tags: { region: "eu", authorization: "secret" },
      sdk: { name: "sentry.python", version: "2.0.0" },
      exception: {
        values: [{
          type: "ValueError",
          value: "invalid card",
          stacktrace: {
            frames: [{
              filename: "app/views.py",
              function: "charge",
              lineno: 42,
              in_app: true
            }]
          }
        }]
      }
    })))

    expect(mapped?.eventId).toBe("abc123def4567890abcdef1234567890")
    expect(mapped?.input).toMatchObject({
      external_id: "abc123de-f456-7890-abcd-ef1234567890",
      source: "sentry",
      type: "exception",
      level: "error",
      title: "ValueError: invalid card",
      fingerprint: "sentry:ValueError:app/views.py:charge"
    })
    expect(mapped?.input.body).toContain("app/views.py:42 in charge")
    expect(mapped?.input.body).toContain("env=production")
    expect(mapped?.input.data).toMatchObject({
      platform: "python",
      environment: "production",
      release: "1.4.2",
      sdk: "sentry.python/2.0.0",
      tags: { region: "eu", authorization: "secret" }
    })
  })

  it("cleans multi-line exception titles", () => {
    const mapped = mapSentryEvent(encoder.encode(JSON.stringify({
      event_id: "0",
      exception: {
        values: [{
          type: "ArgumentError",
          value: "bad billing period (ArgumentError)\n\n  raise ArgumentError\n  ^^^^^"
        }]
      }
    })))
    expect(mapped?.input.title).toBe("ArgumentError: bad billing period")
  })

  it.each([
    ["fatal", "critical"],
    ["error", "error"],
    ["warning", "warning"],
    ["info", "info"],
    ["debug", "info"]
  ] as const)("maps %s to %s", (input, output) => {
    expect(sentryLevel(input)).toBe(output)
  })

  it("uses message templates for grouping while showing formatted text", () => {
    const first = mapSentryEvent(encoder.encode(JSON.stringify({
      event_id: "1",
      logentry: { message: "user %s failed", formatted: "user 1 failed" }
    })))
    const second = mapSentryEvent(encoder.encode(JSON.stringify({
      event_id: "2",
      logentry: { message: "user %s failed", formatted: "user 2 failed" }
    })))
    expect(first?.input.title).toBe("user 1 failed")
    expect(second?.input.title).toBe("user 2 failed")
    expect(first?.input.fingerprint).toBe("sentry:msg:user %s failed")
    expect(second?.input.fingerprint).toBe(first?.input.fingerprint)
  })

  it("preserves explicit fingerprints and drops the default placeholder", () => {
    const mapped = mapSentryEvent(encoder.encode(JSON.stringify({
      event_id: "0",
      message: "boom",
      fingerprint: ["{{ default }}", "my-group", "v2"]
    })))
    expect(mapped?.input.fingerprint).toBe("my-group:v2")
  })

  it("ignores transaction-only envelope items at the mapping boundary", () => {
    const [item] = splitSentryEnvelope(envelope("0", {
      type: "transaction",
      transaction: "GET /"
    }, "transaction"))
    expect(item?.type).toBe("transaction")
    expect(item && mapSentryEvent(item.payload)).toBeUndefined()
  })

  it("bounds oversized tag values without dropping the mapped event", () => {
    const mapped = mapSentryEvent(encoder.encode(JSON.stringify({
      event_id: "0",
      message: "boom",
      tags: { huge: "x".repeat(300 * 1_024) }
    })))
    expect(mapped?.input.title).toBe("boom")
    expect(encoder.encode(JSON.stringify(mapped?.input.data)).byteLength).toBeLessThan(256 * 1_024)
  })

  it("decompresses gzip request bodies", async () => {
    const body = envelope("0", { event_id: "0", message: "hello" })
    const request = new Request("https://ops.example.com/api/1/envelope/", {
      method: "POST",
      headers: { "Content-Encoding": "gzip" },
      body: await gzip(body)
    })
    expect(await readSentryBody(request)).toEqual(body)
  })

  it("rejects unsupported encodings and oversized request bodies", async () => {
    const unsupported = new Request("https://ops.example.com/api/1/envelope/", {
      method: "POST",
      headers: { "Content-Encoding": "br" },
      body: encoder.encode("body")
    })
    await expect(readSentryBody(unsupported)).rejects.toMatchObject({ status: 415 })

    const oversized = new Request("https://ops.example.com/api/1/envelope/", {
      method: "POST",
      body: new Uint8Array(SENTRY_MAX_COMPRESSED_BYTES + 1)
    })
    await expect(readSentryBody(oversized)).rejects.toMatchObject({ status: 413 })
  })
})
