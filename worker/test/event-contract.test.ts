import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { EventAction, toApiFailure } from "../src/api-models.js"
import {
  decodeCreateEventInput,
  encodedEventPayloadBytes,
  EVENT_BODY_MAX_LENGTH,
  EVENT_DATA_MAX_ARRAY_ITEMS,
  EVENT_DATA_MAX_DEPTH,
  EVENT_DATA_MAX_OBJECT_KEYS,
  EVENT_EXTERNAL_ID_MAX_LENGTH,
  EVENT_FINGERPRINT_MAX_LENGTH,
  EVENT_PAYLOAD_MAX_BYTES,
  EVENT_TITLE_MAX_LENGTH
} from "../src/event-contract.js"
import type { InvalidEvent } from "../src/errors.js"

const decode = (input: unknown) => Effect.runPromise(decodeCreateEventInput(input))

const captureValidation = async (input: unknown): Promise<InvalidEvent> => {
  try {
    await decode(input)
    throw new Error("expected event validation to fail")
  } catch (error) {
    expect(error).toMatchObject({
      _tag: "InvalidEvent"
    })
    return error as InvalidEvent
  }
}

const issuePaths = (error: InvalidEvent): ReadonlyArray<ReadonlyArray<string | number>> =>
  Array.isArray(error.issues)
    ? error.issues.map((issue) => issue.path)
    : []

describe("event ingestion contract", () => {
  it("trims values while preserving accepted boundary lengths", async () => {
    const input = await decode({
      title: ` ${"t".repeat(EVENT_TITLE_MAX_LENGTH)} `,
      body: "b".repeat(EVENT_BODY_MAX_LENGTH),
      external_id: "e".repeat(EVENT_EXTERNAL_ID_MAX_LENGTH),
      fingerprint: "f".repeat(EVENT_FINGERPRINT_MAX_LENGTH)
    })

    expect(input.title).toHaveLength(EVENT_TITLE_MAX_LENGTH)
    expect(input.body).toHaveLength(EVENT_BODY_MAX_LENGTH)
    expect(input.external_id).toHaveLength(EVENT_EXTERNAL_ID_MAX_LENGTH)
    expect(input.fingerprint).toHaveLength(EVENT_FINGERPRINT_MAX_LENGTH)
  })

  it("requires external IDs to be non-empty when supplied", async () => {
    const error = await captureValidation({
      title: "Blank external id",
      external_id: "   "
    })
    expect(issuePaths(error)).toContainEqual(["external_id"])
  })

  it("rejects over-limit fields instead of silently truncating them", async () => {
    const titleError = await captureValidation({
      title: "t".repeat(EVENT_TITLE_MAX_LENGTH + 1)
    })
    expect(issuePaths(titleError)).toContainEqual(["title"])

    const externalIdError = await captureValidation({
      title: "External id",
      external_id: "e".repeat(EVENT_EXTERNAL_ID_MAX_LENGTH + 1)
    })
    expect(issuePaths(externalIdError)).toContainEqual(["external_id"])

    const fingerprintError = await captureValidation({
      title: "Fingerprint",
      fingerprint: "f".repeat(EVENT_FINGERPRINT_MAX_LENGTH + 1)
    })
    expect(issuePaths(fingerprintError)).toContainEqual(["fingerprint"])
  })

  it("maps schema failures to the stable 422 API error shape", async () => {
    const error = await captureValidation({ title: "" })
    expect(toApiFailure(error)).toMatchObject({
      _tag: "InvalidError",
      error: "validation_error",
      message: "event payload failed validation",
      issues: [{ path: ["title"] }]
    })
  })

  it("requires a calendar-valid RFC 3339 occurrence time", async () => {
    await captureValidation({
      title: "Invalid date",
      occurred_at: "2026-02-30T10:00:00Z"
    })
    await captureValidation({
      title: "Missing zone",
      occurred_at: "2026-08-30T10:00:00"
    })

    const decoded = await decode({
      title: "Offset date",
      occurred_at: "2026-08-30T14:30:00+02:30"
    })
    expect(decoded.occurred_at).toBe("2026-08-30T12:00:00.000Z")

    const historical = await decode({
      title: "Historical event",
      occurred_at: "0099-01-01T00:00:00Z"
    })
    expect(historical.occurred_at).toBe("0099-01-01T00:00:00.000Z")
  })

  it("encodes legacy absolute action URL schemes in event responses", async () => {
    const legacyActions = [
      { label: "Email on-call", url: "mailto:on-call@example.com" },
      { label: "Open archive", url: "ftp://example.com/archive.zip" }
    ]

    for (const action of legacyActions) {
      await expect(
        Effect.runPromise(Schema.encodeUnknownEffect(EventAction)(action))
      ).resolves.toEqual(action)
    }
  })

  it("requires data to be a bounded JSON object", async () => {
    await captureValidation({ title: "Array root", data: [1, 2, 3] })

    const tooManyItems = await captureValidation({
      title: "Large array",
      data: { items: Array.from({ length: EVENT_DATA_MAX_ARRAY_ITEMS + 1 }, (_, index) => index) }
    })
    expect(issuePaths(tooManyItems)).toContainEqual(["data", "items"])

    const tooManyKeys = Object.fromEntries(
      Array.from({ length: EVENT_DATA_MAX_OBJECT_KEYS + 1 }, (_, index) => [`key_${index}`, index])
    )
    const objectError = await captureValidation({ title: "Large object", data: tooManyKeys })
    expect(issuePaths(objectError)).toContainEqual(["data"])
  })

  it("rejects data nested beyond the documented depth", async () => {
    let nested: Record<string, unknown> = { value: true }
    for (let depth = 0; depth <= EVENT_DATA_MAX_DEPTH; depth += 1) {
      nested = { child: nested }
    }

    const error = await captureValidation({ title: "Deep context", data: nested })
    expect((error.issues ?? []).some((issue) =>
      issue.message.includes("nested levels")
    )).toBe(true)
  })

  it("rejects non-JSON and circular values at internal call boundaries", async () => {
    await captureValidation({ title: "Undefined", data: { value: undefined } })
    await captureValidation({ title: "Date", data: { value: new Date() } })

    const circular: Record<string, unknown> = {}
    circular.self = circular
    await captureValidation({ title: "Circular", data: circular })
  })

  it("enforces the encoded event payload ceiling", async () => {
    const oversized = {
      title: "Oversized",
      body: "x".repeat(EVENT_PAYLOAD_MAX_BYTES)
    }
    expect(encodedEventPayloadBytes(oversized)).toBeGreaterThan(EVENT_PAYLOAD_MAX_BYTES)
    await captureValidation(oversized)
  })
})
