import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect"
import { appError, type AppError, type ValidationIssue } from "./errors.js"

export const EVENT_PAYLOAD_MAX_BYTES = 256 * 1024
export const EVENT_TITLE_MAX_LENGTH = 240
export const EVENT_BODY_MAX_LENGTH = 8_000
export const EVENT_SOURCE_MAX_LENGTH = 160
export const EVENT_TYPE_MAX_LENGTH = 160
export const EVENT_FINGERPRINT_MAX_LENGTH = 500
export const EVENT_EXTERNAL_ID_MAX_LENGTH = 500
export const EVENT_ACTIONS_MAX_ITEMS = 3
export const EVENT_ACTION_LABEL_MAX_LENGTH = 40
export const EVENT_ACTION_URL_MAX_LENGTH = 2_048
export const EVENT_DATA_MAX_DEPTH = 12
export const EVENT_DATA_MAX_ARRAY_ITEMS = 100
export const EVENT_DATA_MAX_OBJECT_KEYS = 200

const encoder = new TextEncoder()
const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u

const encodedBytes = (value: unknown): number => {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? Number.POSITIVE_INFINITY : encoder.encode(json).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const trimmedString = () => Schema.String.pipe(
  Schema.decode<typeof Schema.String>({
    decode: SchemaGetter.transform((value) => value.trim()),
    encode: SchemaGetter.transform((value) => value.trim())
  })
)

const text = (
  description: string,
  minimum: number,
  maximum: number
) => trimmedString()
  .check(Schema.isMinLength(minimum, {
    message: `${description} must contain at least ${minimum} character${minimum === 1 ? "" : "s"}`
  }))
  .check(Schema.isMaxLength(maximum, {
    message: `${description} must contain at most ${maximum} characters`
  }))
  .annotate({ description })

const parseRfc3339 = (value: string): string | undefined => {
  const match = rfc3339.exec(value)
  if (!match) return undefined

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const fraction = match[7] ?? ""
  const zone = match[8] ?? "Z"
  const millisecond = Number((fraction + "000").slice(0, 3))

  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) return undefined

  const localMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const local = new Date(localMillis)
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) return undefined

  let offsetMinutes = 0
  if (zone !== "Z") {
    const sign = zone.startsWith("+") ? 1 : -1
    const offsetHour = Number(zone.slice(1, 3))
    const offsetMinute = Number(zone.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) return undefined
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute)
  }

  const instant = new Date(localMillis - offsetMinutes * 60_000)
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString()
}

export const EventLevel = Schema.Literals(["info", "success", "warning", "error", "critical"])
  .annotate({ description: "Operational severity level" })

export const EventTitle = text("Event title", 1, EVENT_TITLE_MAX_LENGTH)
export const EventBody = text("Event body", 0, EVENT_BODY_MAX_LENGTH)
export const EventSource = text("Event source", 0, EVENT_SOURCE_MAX_LENGTH)
export const EventType = text("Event type", 0, EVENT_TYPE_MAX_LENGTH)
export const EventFingerprint = text("Event fingerprint", 0, EVENT_FINGERPRINT_MAX_LENGTH)
export const EventExternalId = text("Event external id", 0, EVENT_EXTERNAL_ID_MAX_LENGTH)

export const EventOccurredAt = text("Event occurrence timestamp", 1, 64)
  .check(Schema.makeFilter<string>((value) =>
    parseRfc3339(value) !== undefined || "occurred_at must be a valid RFC 3339 timestamp"
  ))
  .pipe(Schema.decode<ReturnType<typeof text>>({
    decode: SchemaGetter.transform((value) => parseRfc3339(value) ?? value),
    encode: SchemaGetter.transform((value) => value)
  }))
  .annotate({ description: "RFC 3339 timestamp normalized to UTC" })

export const EventActionInputSchema = Schema.Struct({
  label: text("Action label", 1, EVENT_ACTION_LABEL_MAX_LENGTH),
  url: text("Action URL", 1, EVENT_ACTION_URL_MAX_LENGTH)
    .check(Schema.makeFilter<string>((value) => {
      try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:"
          ? true
          : "action URL must use http or https"
      } catch {
        return "action URL must be absolute"
      }
    }))
    .pipe(Schema.decode<ReturnType<typeof text>>({
      decode: SchemaGetter.transform((value) => new URL(value).href),
      encode: SchemaGetter.transform((value) => value)
    }))
})

const inspectJsonValue = (
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
  depth: number,
  issues: Array<Schema.FilterIssue>,
  seen: WeakSet<object>
): void => {
  if (depth > EVENT_DATA_MAX_DEPTH) {
    issues.push({ path, issue: `data must not exceed ${EVENT_DATA_MAX_DEPTH} nested levels` })
    return
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push({ path, issue: "data numbers must be finite" })
    return
  }
  if (typeof value !== "object") {
    issues.push({ path, issue: "data values must be valid JSON values" })
    return
  }
  if (seen.has(value)) {
    issues.push({ path, issue: "data must not contain circular references" })
    return
  }
  seen.add(value)

  if (Array.isArray(value)) {
    if (value.length > EVENT_DATA_MAX_ARRAY_ITEMS) {
      issues.push({ path, issue: `data arrays may contain at most ${EVENT_DATA_MAX_ARRAY_ITEMS} items` })
      return
    }
    value.forEach((entry, index) =>
      inspectJsonValue(entry, [...path, index], depth + 1, issues, seen)
    )
    return
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    issues.push({ path, issue: "data values must be plain JSON objects" })
    return
  }

  const entries = Object.entries(value)
  if (entries.length > EVENT_DATA_MAX_OBJECT_KEYS) {
    issues.push({ path, issue: `data objects may contain at most ${EVENT_DATA_MAX_OBJECT_KEYS} properties` })
    return
  }
  for (const [key, entry] of entries) {
    inspectJsonValue(entry, [...path, key], depth + 1, issues, seen)
  }
}

export const EventData = Schema.Record(Schema.String, Schema.Unknown)
  .check(Schema.makeFilter<Record<string, unknown>>((value) => {
    const issues: Array<Schema.FilterIssue> = []
    inspectJsonValue(value, [], 0, issues, new WeakSet())
    return issues
  }))
  .annotate({
    description: `JSON object limited to ${EVENT_DATA_MAX_DEPTH} levels, ${EVENT_DATA_MAX_OBJECT_KEYS} properties per object, and ${EVENT_DATA_MAX_ARRAY_ITEMS} items per array`
  })

export const CreateEventInputSchema = Schema.Struct({
  external_id: Schema.optional(EventExternalId),
  source: Schema.optional(EventSource),
  type: Schema.optional(EventType),
  level: Schema.optional(EventLevel),
  title: EventTitle,
  body: Schema.optional(EventBody),
  fingerprint: Schema.optional(EventFingerprint),
  occurred_at: Schema.optional(EventOccurredAt),
  data: Schema.optional(EventData),
  actions: Schema.optional(
    Schema.Array(EventActionInputSchema)
      .check(Schema.isMaxLength(EVENT_ACTIONS_MAX_ITEMS, {
        message: `actions may contain at most ${EVENT_ACTIONS_MAX_ITEMS} items`
      }))
  )
}).check(Schema.makeFilter((value) =>
  encodedBytes(value) <= EVENT_PAYLOAD_MAX_BYTES ||
    `encoded event payload must not exceed ${EVENT_PAYLOAD_MAX_BYTES} bytes`
)).annotate({
  description: `Operational event payload. The encoded JSON payload must not exceed ${EVENT_PAYLOAD_MAX_BYTES} bytes.`
})

export type CreateEventInput = typeof CreateEventInputSchema.Type
export type EventActionInput = typeof EventActionInputSchema.Type

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

const validationIssues = (issue: SchemaIssue.Issue): ReadonlyArray<ValidationIssue> =>
  formatIssue(issue).issues.map((entry) => ({
    path: (entry.path ?? []).map((segment) =>
      typeof segment === "number" ? segment : String(segment)
    ),
    message: entry.message
  }))

export const decodeCreateEventInput = (
  input: unknown
): Effect.Effect<CreateEventInput, AppError> =>
  Schema.decodeUnknownEffect(CreateEventInputSchema)(input).pipe(
    Effect.mapError((error) => appError(
      422,
      "validation_error",
      "event payload failed validation",
      validationIssues(error.issue)
    ))
  )

export const encodedEventPayloadBytes = encodedBytes
