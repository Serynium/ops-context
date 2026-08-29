import { Effect } from "effect"
import { invalid, notFound, type AppError } from "./errors.js"
import { base64UrlDecode, base64UrlEncode } from "./crypto.js"
import { clamp, newId, nowIso } from "./ids.js"
import { atLeast, isLevel } from "./levels.js"
import { redactValue } from "./redact.js"
import { AppConfig, CredentialCrypto, Database, PushQueue } from "./services.js"
import { getSettings } from "./settings.js"
import { matchSilence } from "./silences.js"
import { listEnabledSubscriptionRows } from "./subscriptions.js"
import type {
  DeliveryRow,
  EventRow,
  EventView,
  Level,
  ProjectRow,
  PushJobMessage
} from "./types.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface CreateEventInput {
  readonly external_id?: string | undefined
  readonly source?: string | undefined
  readonly type?: string | undefined
  readonly level?: Level | undefined
  readonly title: string
  readonly body?: string | undefined
  readonly fingerprint?: string | undefined
  readonly occurred_at?: string | undefined
  readonly data?: unknown | undefined
}

export interface EventPage {
  readonly events: ReadonlyArray<EventView>
  readonly next_cursor?: string | undefined
}

const truncate = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : ""

const parsePayload = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export const toEventView = (row: EventRow): EventView => ({
  id: row.id,
  ...(row.external_id ? { external_id: row.external_id } : {}),
  project_id: row.project_id,
  project_name: row.project_name,
  project_slug: row.project_slug,
  project_icon: row.project_icon,
  source: row.source,
  type: row.type,
  level: row.level,
  title: row.title,
  body: row.body,
  fingerprint: row.fingerprint,
  data: parsePayload(row.payload_json),
  occurred_at: row.occurred_at,
  created_at: row.created_at,
  silenced: row.silence_id !== null,
  ...(row.silence_id ? { silence_id: row.silence_id } : {})
})

const eventSelect = `
  SELECT
    e.id,
    e.external_id,
    e.project_id,
    p.name AS project_name,
    p.slug AS project_slug,
    p.icon AS project_icon,
    e.source,
    e.type,
    e.level,
    e.title,
    e.body,
    e.fingerprint,
    e.payload_json,
    e.occurred_at,
    e.created_at,
    e.silence_id
  FROM events e
  JOIN projects p ON p.id = e.project_id
`

export const getEvent = (id: string): Effect.Effect<EventView, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const row = yield* db.first<EventRow>(`${eventSelect} WHERE e.id = ?`, [id])
    if (!row) return yield* Effect.fail(notFound("event not found"))
    return toEventView(row)
  })

const parseOccurredAt = (value: string | undefined, fallback: string): string => {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

const normalizeInput = (input: CreateEventInput, createdAt: string): CreateEventInput => {
  const title = truncate(input.title, 240)
  if (!title) throw invalid("event title is required")
  const level = input.level ?? "info"
  if (!isLevel(level)) throw invalid("event level is invalid")

  const externalId = truncate(input.external_id, 500)
  return {
    title,
    body: truncate(input.body, 8_000),
    level,
    source: truncate(input.source, 160),
    type: truncate(input.type, 160),
    fingerprint: truncate(input.fingerprint, 500),
    ...(externalId ? { external_id: externalId } : {}),
    occurred_at: parseOccurredAt(input.occurred_at, createdAt),
    ...(input.data === undefined ? {} : { data: input.data })
  }
}

export const createEventForProject = (
  project: ProjectRow,
  input: CreateEventInput
): Effect.Effect<EventView, AppError, Database | PushQueue | AppConfig | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    const queue = yield* PushQueue
    const createdAt = nowIso()
    const normalized = yield* Effect.try({
      try: () => normalizeInput(input, createdAt),
      catch: (cause) =>
        typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === "AppError"
          ? (cause as AppError)
          : invalid("event payload is invalid")
    })

    if (normalized.external_id) {
      const existing = yield* db.first<{ readonly id: string }>(
        "SELECT id FROM events WHERE project_id = ? AND external_id = ? LIMIT 1",
        [project.id, normalized.external_id]
      )
      if (existing) return yield* getEvent(existing.id)
    }

    const settings = yield* getSettings
    const payload = redactValue(normalized.data ?? {}, settings.redact_keys)
    const data = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}

    const silenceId = yield* matchSilence(project.id, [
      ["fingerprint", normalized.fingerprint ?? ""],
      ["title", normalized.title],
      ["source", normalized.source ?? ""]
    ])

    const eventId = yield* newId("evt")
    const shouldNotify = project.notify === 1 && atLeast(normalized.level ?? "info", project.min_level) && !silenceId
    const subscriptions = shouldNotify ? yield* listEnabledSubscriptionRows : []
    const messages: ReadonlyArray<PushJobMessage> = subscriptions.map((subscription) => ({
      eventId,
      subscriptionId: subscription.id
    }))

    const statements = [
      {
        sql: `INSERT INTO events
          (id, external_id, project_id, source, type, level, title, body, fingerprint, payload_json, occurred_at, created_at, silence_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          eventId,
          normalized.external_id ?? null,
          project.id,
          normalized.source ?? "",
          normalized.type ?? "",
          normalized.level ?? "info",
          normalized.title,
          normalized.body ?? "",
          normalized.fingerprint ?? "",
          JSON.stringify(data),
          normalized.occurred_at ?? createdAt,
          createdAt,
          silenceId
        ]
      },
      ...subscriptions.map((subscription) => ({
        sql: `INSERT INTO push_jobs
          (event_id, subscription_id, state, attempts, available_at, queued_at, lease_until, last_error, updated_at)
          VALUES (?, ?, 'pending', 0, ?, NULL, NULL, '', ?)`,
        params: [eventId, subscription.id, createdAt, createdAt]
      }))
    ]

    yield* db.batch(statements)

    if (messages.length > 0) {
      const published = yield* queue.sendMany(messages).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false))
      )
      if (published) {
        const queuedAt = nowIso()
        yield* db.run(
          "UPDATE push_jobs SET state = 'queued', queued_at = ?, updated_at = ? WHERE event_id = ? AND state = 'pending'",
          [queuedAt, queuedAt, eventId]
        )
      }
    }

    return yield* getEvent(eventId)
  })

interface Cursor {
  readonly createdAt: string
  readonly id: string
}

const encodeCursor = (cursor: Cursor): string =>
  base64UrlEncode(encoder.encode(JSON.stringify(cursor)))

const decodeCursor = (value: string): Cursor | null => {
  try {
    const parsed = JSON.parse(decoder.decode(base64UrlDecode(value))) as Partial<Cursor>
    return typeof parsed.createdAt === "string" && typeof parsed.id === "string"
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : null
  } catch {
    return null
  }
}

export interface ListEventsInput {
  readonly project?: string | undefined
  readonly level?: string | undefined
  readonly source?: string | undefined
  readonly silenced?: string | undefined
  readonly before?: string | undefined
  readonly limit?: string | undefined
}

export const listEvents = (
  input: ListEventsInput
): Effect.Effect<EventPage, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const conditions: Array<string> = []
    const params: Array<unknown> = []

    if (input.project) {
      conditions.push("e.project_id = ?")
      params.push(input.project)
    }
    if (input.level) {
      if (!isLevel(input.level)) return yield* Effect.fail(invalid("level filter is invalid"))
      conditions.push("e.level = ?")
      params.push(input.level)
    }
    if (input.source) {
      conditions.push("e.source = ?")
      params.push(input.source)
    }
    if (input.silenced !== undefined && input.silenced !== "true" && input.silenced !== "false") {
      return yield* Effect.fail(invalid("silenced filter must be true or false"))
    }
    if (input.silenced === "true") conditions.push("e.silence_id IS NOT NULL")
    if (input.silenced === "false") conditions.push("e.silence_id IS NULL")

    if (input.before) {
      const cursor = decodeCursor(input.before)
      if (!cursor) return yield* Effect.fail(invalid("before cursor is invalid"))
      conditions.push("(e.created_at < ? OR (e.created_at = ? AND e.id < ?))")
      params.push(cursor.createdAt, cursor.createdAt, cursor.id)
    }

    const requestedLimit = Number.parseInt(input.limit ?? "50", 10)
    const limit = clamp(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1, 100)
    params.push(limit + 1)

    const rows = yield* db.all<EventRow>(
      `${eventSelect}
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
      params
    )

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const last = pageRows.at(-1)
    return {
      events: pageRows.map(toEventView),
      ...(hasMore && last ? { next_cursor: encodeCursor({ createdAt: last.created_at, id: last.id }) } : {})
    }
  })

export const eventDeliveries = (
  eventId: string
): Effect.Effect<ReadonlyArray<DeliveryRow>, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* getEvent(eventId)
    return yield* db.all<DeliveryRow>(
      `SELECT
         d.id,
         d.event_id,
         d.subscription_id,
         COALESCE(s.name, '') AS subscription_name,
         d.status,
         d.response_status,
         d.error,
         d.attempted_at
       FROM deliveries d
       LEFT JOIN push_subscriptions s ON s.id = d.subscription_id
       WHERE d.event_id = ?
       ORDER BY d.attempted_at DESC`,
      [eventId]
    )
  })

export const unsilenceEvent = (
  eventId: string
): Effect.Effect<{ readonly event: EventView; readonly deliveries: ReadonlyArray<DeliveryRow> }, AppError, Database | PushQueue> =>
  Effect.gen(function*() {
    const db = yield* Database
    const queue = yield* PushQueue
    const current = yield* getEvent(eventId)
    if (!current.silenced) {
      return { event: current, deliveries: yield* eventDeliveries(eventId) }
    }

    const subscriptions = yield* listEnabledSubscriptionRows
    const now = nowIso()
    yield* db.batch([
      {
        sql: "UPDATE events SET silence_id = NULL WHERE id = ?",
        params: [eventId]
      },
      ...subscriptions.map((subscription) => ({
        sql: `INSERT INTO push_jobs
          (event_id, subscription_id, state, attempts, available_at, queued_at, lease_until, last_error, updated_at)
          VALUES (?, ?, 'pending', 0, ?, NULL, NULL, '', ?)
          ON CONFLICT(event_id, subscription_id) DO UPDATE SET
            state = 'pending', available_at = excluded.available_at, queued_at = NULL,
            lease_until = NULL, last_error = '', updated_at = excluded.updated_at`,
        params: [eventId, subscription.id, now, now]
      }))
    ])

    const messages = subscriptions.map((subscription) => ({ eventId, subscriptionId: subscription.id }))
    if (messages.length > 0) {
      const published = yield* queue.sendMany(messages).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false))
      )
      if (published) {
        const queuedAt = nowIso()
        yield* db.run(
          "UPDATE push_jobs SET state = 'queued', queued_at = ?, updated_at = ? WHERE event_id = ?",
          [queuedAt, queuedAt, eventId]
        )
      }
    }

    return {
      event: yield* getEvent(eventId),
      deliveries: yield* eventDeliveries(eventId)
    }
  })
