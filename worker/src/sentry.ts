import { Context, Effect, Layer } from "effect"
import { Events, Projects } from "./application.js"
import type { CreateEventInput } from "./events.js"
import type { Level } from "./types.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const SENTRY_MAX_COMPRESSED_BYTES = 2 << 20
export const SENTRY_MAX_DECOMPRESSED_BYTES = 16 << 20
const SENTRY_MAX_TAGS = 50
const SENTRY_MAX_TAG_BYTES = 1_024
const SENTRY_MAX_DATA_BYTES = 256 << 10
const SENTRY_MAX_CONTEXT_BYTES = 8_000

export const isSentryEnvelopePath = (pathname: string): boolean =>
  /^\/api\/[^/]+\/envelope\/$/u.test(pathname)

export interface EnvelopeItem {
  readonly type: string
  readonly payload: Uint8Array
}

export interface MappedSentryEvent {
  readonly eventId: string
  readonly input: CreateEventInput
}

type JsonRecord = Record<string, unknown>

export class SentryRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "SentryRequestError"
    this.status = status
    this.code = code
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string => typeof value === "string" ? value : ""

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

const bool = (value: unknown): boolean => value === true

const firstNonEmpty = (...values: ReadonlyArray<string>): string => {
  for (const value of values) {
    const normalized = value.trim()
    if (normalized) return normalized
  }
  return ""
}

const firstLine = (value: string): string => {
  for (const line of value.split("\n")) {
    const normalized = line.trim()
    if (normalized) return normalized
  }
  return ""
}

const clip = (value: string, maxBytes: number): string => {
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0) {
    const boundary = bytes[end]
    if (boundary === undefined || (boundary & 0xc0) !== 0x80) break
    end--
  }
  return decoder.decode(bytes.subarray(0, end))
}

const joinTypeValue = (type: string, value: string): string => {
  const normalizedType = type.trim()
  const normalizedValue = value.trim()
  if (normalizedType && normalizedValue) return `${normalizedType}: ${normalizedValue}`
  return normalizedType || normalizedValue
}

const stripDashes = (value: string): string => value.replaceAll("-", "")

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === "string") return message
  }
  return error instanceof Error ? error.message : "unknown error"
}

const secureJson = (body: unknown, status = 200, extraHeaders?: HeadersInit): Response => {
  const headers = new Headers(extraHeaders)
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "same-origin")
  return Response.json(body, { status, headers })
}

export const sentryKey = (request: Request): string => {
  const authorization = request.headers.get("x-sentry-auth") ?? ""
  for (const token of authorization.split(/[\s,]+/u)) {
    if (token.startsWith("sentry_key=")) return token.slice("sentry_key=".length)
  }
  return new URL(request.url).searchParams.get("sentry_key") ?? ""
}

const readStreamWithLimit = async (
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<Uint8Array> => {
  if (!stream) return new Uint8Array()

  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (!result.value) continue
      total += result.value.byteLength
      if (total > maxBytes) {
        await reader.cancel("request body too large").catch(() => undefined)
        throw new SentryRequestError(413, "too_large", "request body too large")
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })

export const readSentryBody = async (request: Request): Promise<Uint8Array> => {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10)
  if (Number.isFinite(declaredLength) && declaredLength > SENTRY_MAX_COMPRESSED_BYTES) {
    throw new SentryRequestError(413, "too_large", "request body too large")
  }

  let compressed: Uint8Array
  try {
    compressed = await readStreamWithLimit(request.body, SENTRY_MAX_COMPRESSED_BYTES)
  } catch (error) {
    if (error instanceof SentryRequestError) throw error
    throw new SentryRequestError(400, "invalid", "could not read request body")
  }

  const contentEncoding = (request.headers.get("content-encoding") ?? "").trim().toLowerCase()
  if (!contentEncoding || contentEncoding === "identity") return compressed
  if (contentEncoding !== "gzip" && contentEncoding !== "deflate" && contentEncoding !== "zlib") {
    throw new SentryRequestError(415, "unsupported", "unsupported Content-Encoding")
  }

  const format: CompressionFormat = contentEncoding === "gzip" ? "gzip" : "deflate"
  try {
    const decompressed = streamOf(compressed).pipeThrough(new DecompressionStream(format))
    return await readStreamWithLimit(decompressed, SENTRY_MAX_DECOMPRESSED_BYTES)
  } catch (error) {
    if (error instanceof SentryRequestError) throw error
    const kind = contentEncoding === "gzip" ? "gzip" : "deflate"
    throw new SentryRequestError(400, "invalid", `malformed ${kind} body`)
  }
}

const indexOfNewline = (body: Uint8Array, start: number): number => {
  for (let index = start; index < body.byteLength; index++) {
    if (body[index] === 0x0a) return index
  }
  return -1
}

export const splitSentryEnvelope = (body: Uint8Array): ReadonlyArray<EnvelopeItem> => {
  const items: Array<EnvelopeItem> = []
  const envelopeHeaderEnd = indexOfNewline(body, 0)
  if (envelopeHeaderEnd < 0) return items

  let cursor = envelopeHeaderEnd + 1
  while (cursor < body.byteLength) {
    const itemHeaderEnd = indexOfNewline(body, cursor)
    const headerBytes = itemHeaderEnd < 0
      ? body.subarray(cursor)
      : body.subarray(cursor, itemHeaderEnd)
    cursor = itemHeaderEnd < 0 ? body.byteLength : itemHeaderEnd + 1

    const headerLine = decoder.decode(headerBytes).trim()
    if (!headerLine) continue

    let header: JsonRecord
    try {
      const parsed: unknown = JSON.parse(headerLine)
      if (!isRecord(parsed)) break
      header = parsed
    } catch {
      break
    }

    if ("type" in header && typeof header.type !== "string") break
    if (
      "length" in header &&
      header.length !== null &&
      (typeof header.length !== "number" || !Number.isInteger(header.length))
    ) {
      break
    }

    const type = text(header.type)
    const length = typeof header.length === "number" ? header.length : undefined
    let payload: Uint8Array
    if (length !== undefined && length >= 0 && length <= body.byteLength - cursor) {
      payload = body.slice(cursor, cursor + length)
      cursor += length
      if (body[cursor] === 0x0a) cursor++
    } else {
      const payloadEnd = indexOfNewline(body, cursor)
      if (payloadEnd < 0) {
        payload = body.slice(cursor)
        cursor = body.byteLength
      } else {
        payload = body.slice(cursor, payloadEnd)
        cursor = payloadEnd + 1
      }
    }
    items.push({ type, payload })
  }

  return items
}

const messageParts = (event: JsonRecord): { readonly template: string; readonly formatted: string } => {
  const logentry = isRecord(event.logentry) ? event.logentry : undefined
  const logentryTemplate = text(logentry?.message)
  const logentryFormatted = text(logentry?.formatted)
  if (logentryTemplate || logentryFormatted) {
    return { template: logentryTemplate, formatted: logentryFormatted }
  }

  if (typeof event.message === "string") {
    return { template: event.message, formatted: event.message }
  }
  if (isRecord(event.message)) {
    return {
      template: text(event.message.message),
      formatted: text(event.message.formatted)
    }
  }
  return { template: "", formatted: "" }
}

const sentryMessage = (event: JsonRecord): string => {
  const parts = messageParts(event)
  return firstNonEmpty(parts.formatted, parts.template)
}

const sentryMessageTemplate = (event: JsonRecord): string => {
  const parts = messageParts(event)
  return firstNonEmpty(parts.template, parts.formatted)
}

const exceptionValues = (event: JsonRecord): ReadonlyArray<JsonRecord> => {
  const exception = isRecord(event.exception) ? event.exception : undefined
  if (!Array.isArray(exception?.values)) return []
  return exception.values.filter(isRecord)
}

const exceptionFrames = (exception: JsonRecord): ReadonlyArray<JsonRecord> => {
  const stacktrace = isRecord(exception.stacktrace) ? exception.stacktrace : undefined
  if (!Array.isArray(stacktrace?.frames)) return []
  return stacktrace.frames.filter(isRecord)
}

const topFrame = (frames: ReadonlyArray<JsonRecord>): JsonRecord | undefined => {
  for (let index = frames.length - 1; index >= 0; index--) {
    const frame = frames[index]
    if (frame && bool(frame.in_app)) return frame
  }
  return frames.at(-1)
}

export const sentryLevel = (value: unknown): Level | undefined => {
  switch (text(value).trim().toLowerCase()) {
    case "fatal":
      return "critical"
    case "error":
      return "error"
    case "warning":
      return "warning"
    case "info":
    case "debug":
      return "info"
    default:
      return undefined
  }
}

const exceptionFingerprint = (exception: JsonRecord): string => {
  const parts = ["sentry"]
  const type = firstNonEmpty(text(exception.type), text(exception.module))
  if (type) parts.push(type)
  const frame = topFrame(exceptionFrames(exception))
  if (frame) {
    const location = firstNonEmpty(text(frame.module), text(frame.filename))
    if (location) parts.push(location)
    const functionName = text(frame.function)
    if (functionName) parts.push(functionName)
  }
  return parts.join(":")
}

const sentryFingerprint = (event: JsonRecord, fallback: string): string => {
  const explicit = Array.isArray(event.fingerprint)
    ? event.fingerprint
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value && value !== "{{ default }}" && value !== "{{default}}")
    : []
  return explicit.length > 0 ? explicit.join(":") : fallback.replace(/:$/u, "")
}

const sentryTime = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const date = new Date(value * 1_000)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof value === "string" && value) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return undefined
}

const sentryContextLine = (event: JsonRecord): string => {
  const parts: Array<string> = []
  const environment = text(event.environment)
  const release = text(event.release)
  const serverName = text(event.server_name)
  if (environment) parts.push(`env=${environment}`)
  if (release) parts.push(`release=${release}`)
  if (serverName) parts.push(`server=${serverName}`)
  return parts.join(" · ")
}

const sentryExceptionBody = (exception: JsonRecord, event: JsonRecord): string => {
  const parts: Array<string> = []
  const location = firstNonEmpty(text(event.culprit), text(event.transaction))
  if (location) parts.push(location)

  const frame = topFrame(exceptionFrames(exception))
  if (frame) {
    let line = firstNonEmpty(text(frame.filename), text(frame.module))
    const lineNumber = number(frame.lineno)
    if (lineNumber > 0) line += `:${Math.trunc(lineNumber)}`
    const functionName = text(frame.function)
    if (functionName) line += ` in ${functionName}`
    if (line) parts.push(line)
  }

  const context = sentryContextLine(event)
  if (context) parts.push(context)
  return parts.join("\n")
}

const tagValue = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

const cappedTags = (value: unknown): Record<string, string> => {
  const output: Record<string, string> = {}
  const add = (rawKey: string, rawValue: string): void => {
    if (!rawKey || Object.keys(output).length >= SENTRY_MAX_TAGS) return
    output[clip(rawKey, SENTRY_MAX_TAG_BYTES)] = clip(rawValue, SENTRY_MAX_TAG_BYTES)
  }

  if (isRecord(value)) {
    for (const key of Object.keys(value).sort()) add(key, tagValue(value[key]))
    return output
  }
  if (Array.isArray(value)) {
    for (const pair of value) {
      if (Array.isArray(pair) && pair.length === 2) add(tagValue(pair[0]), tagValue(pair[1]))
    }
  }
  return output
}

const sentryData = (event: JsonRecord): Record<string, unknown> => {
  const output: Record<string, unknown> = {}
  for (const [key, value] of [
    ["event_id", text(event.event_id)],
    ["platform", text(event.platform)],
    ["environment", text(event.environment)],
    ["release", text(event.release)],
    ["server_name", text(event.server_name)],
    ["transaction", text(event.transaction)],
    ["culprit", text(event.culprit)]
  ] as const) {
    if (value) output[key] = clip(value, SENTRY_MAX_CONTEXT_BYTES)
  }

  const sdk = isRecord(event.sdk) ? event.sdk : undefined
  const sdkName = text(sdk?.name)
  if (sdkName) {
    output.sdk = clip(`${sdkName}/${text(sdk?.version)}`.replace(/\/$/u, ""), SENTRY_MAX_TAG_BYTES)
  }

  const tags = cappedTags(event.tags)
  if (Object.keys(tags).length > 0) output.tags = tags

  const exceptions = exceptionValues(event)
  const exception = exceptions.at(-1)
  if (exception) {
    const details: Record<string, unknown> = {}
    const type = text(exception.type)
    const value = text(exception.value)
    if (type) details.type = clip(type, SENTRY_MAX_TAG_BYTES)
    if (value) details.value = clip(value, SENTRY_MAX_CONTEXT_BYTES)

    const frames = exceptionFrames(exception).slice(-10).map((frame) => ({
      file: clip(text(frame.filename), SENTRY_MAX_TAG_BYTES),
      func: clip(text(frame.function), SENTRY_MAX_TAG_BYTES),
      line: Math.trunc(number(frame.lineno)),
      in_app: bool(frame.in_app)
    }))
    if (frames.length > 0) details.frames = frames
    if (Object.keys(details).length > 0) output.exception = details
  }

  if (encoder.encode(JSON.stringify(output)).byteLength > SENTRY_MAX_DATA_BYTES) {
    delete output.tags
    delete output.exception
  }
  return output
}

export const mapSentryEvent = (raw: Uint8Array): MappedSentryEvent | undefined => {
  let event: JsonRecord
  try {
    const parsed: unknown = JSON.parse(decoder.decode(raw))
    if (!isRecord(parsed)) return undefined
    event = parsed
  } catch {
    return undefined
  }

  const eventId = stripDashes(text(event.event_id))
  const externalId = clip(text(event.event_id), 500)
  const occurredAt = sentryTime(event.timestamp)
  const message = sentryMessage(event)
  const exceptions = exceptionValues(event)
  const exception = exceptions.at(-1)

  let type: string
  let title: string
  let body: string
  let level: Level
  let fingerprint: string

  if (exception) {
    type = "exception"
    const exceptionType = text(exception.type)
    const suffix = exceptionType ? ` (${exceptionType})` : ""
    let value = firstLine(text(exception.value))
    if (suffix && value.endsWith(suffix)) value = value.slice(0, -suffix.length)
    title = joinTypeValue(exceptionType, value) || firstLine(message)
    body = sentryExceptionBody(exception, event)
    level = sentryLevel(event.level) ?? "error"
    fingerprint = sentryFingerprint(event, exceptionFingerprint(exception))
  } else if (message) {
    type = "message"
    title = firstLine(message)
    body = sentryContextLine(event)
    level = sentryLevel(event.level) ?? "info"
    fingerprint = sentryFingerprint(event, `sentry:msg:${firstLine(sentryMessageTemplate(event))}`)
  } else {
    return undefined
  }

  if (!title) title = firstNonEmpty(text(event.transaction), text(event.culprit), "Sentry event")
  const input: CreateEventInput = {
    source: "sentry",
    type,
    level,
    title: clip(title, 240),
    body: clip(body, 8_000),
    fingerprint: clip(fingerprint, 500),
    data: sentryData(event),
    ...(externalId ? { external_id: externalId } : {}),
    ...(occurredAt ? { occurred_at: occurredAt } : {})
  }
  return { eventId, input }
}

export class SentryEndpoint extends Context.Service<SentryEndpoint, {
  readonly handle: (request: Request) => Effect.Effect<Response>
}>()("ops-context/SentryEndpoint") {
  static readonly layer = Layer.effect(
    SentryEndpoint,
    Effect.gen(function*() {
      const projects = yield* Projects
      const events = yield* Events

      const handle = (request: Request): Effect.Effect<Response> =>
        Effect.gen(function*() {
          if (request.method !== "POST") {
            return secureJson(
              { error: "method_not_allowed", message: "only POST is supported" },
              405,
              { allow: "POST" }
            )
          }

          const key = sentryKey(request)
          if (!key) {
            return secureJson(
              { error: "unauthorized", message: "missing Sentry DSN key" },
              401
            )
          }

          const authenticated = yield* projects.authenticate(key).pipe(
            Effect.map((project) => ({ ok: true as const, project })),
            Effect.catch(() => Effect.succeed({ ok: false as const }))
          )
          if (!authenticated.ok) {
            return secureJson(
              { error: "unauthorized", message: "invalid Sentry DSN key" },
              401
            )
          }

          const bodyResult = yield* Effect.tryPromise({
            try: () => readSentryBody(request),
            catch: (error) => error instanceof SentryRequestError
              ? error
              : new SentryRequestError(400, "invalid", "could not read request body")
          }).pipe(
            Effect.map((body) => ({ ok: true as const, body })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
          )
          if (!bodyResult.ok) {
            return secureJson(
              { error: bodyResult.error.code, message: bodyResult.error.message },
              bodyResult.error.status
            )
          }

          let firstId = ""
          let stored = 0
          for (const item of splitSentryEnvelope(bodyResult.body)) {
            if (item.type !== "event") continue
            const mapped = mapSentryEvent(item.payload)
            if (!mapped) continue

            const created = yield* events.create(authenticated.project, mapped.input).pipe(
              Effect.map(() => true),
              Effect.catch((error) =>
                Effect.sync(() => {
                  console.warn("sentry.event_rejected", {
                    projectId: authenticated.project.id,
                    error: errorMessage(error)
                  })
                  return false
                })
              )
            )
            if (!created) continue
            if (!firstId) firstId = mapped.eventId
            stored++
          }

          console.info("sentry.envelope", {
            projectId: authenticated.project.id,
            events: stored
          })
          return secureJson({ id: firstId })
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              console.error("sentry endpoint defect", error)
              return secureJson(
                { error: "internal", message: "something went wrong" },
                500
              )
            })
          )
        )

      return SentryEndpoint.of({ handle })
    })
  )
}
