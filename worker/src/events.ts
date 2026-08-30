import { Effect } from "effect"
import { decodeCreateEventInput, type CreateEventInput } from "./event-contract.js"
import {
  eventNotFound,
  invalidEventQuery,
  type CryptographyUnavailable,
  type EventNotFound,
  type InvalidEvent,
  type InvalidEventQuery,
  type QueueUnavailable,
  type RepositoryUnavailable
} from "./errors.js"
import { base64UrlDecode, base64UrlEncode } from "./crypto.js"
import { clamp, newId, nowIso } from "./ids.js"
import { atLeast, isLevel } from "./levels.js"
import { redactValue } from "./redact.js"
import {
  DeliveriesRepository,
  EventsRepository,
  SettingsRepository,
  SilencesRepository,
  SubscriptionsRepository,
  type EventListCriteria
} from "./repositories.js"
import { AppConfig, CredentialCrypto, PushQueue } from "./services.js"
import { getSettings } from "./settings.js"
import { matchSilence } from "./silences.js"
import { listEnabledSubscriptionRows } from "./subscriptions.js"
import type {
  DeliveryRow,
  EventAction,
  EventRow,
  EventView,
  Level,
  ProjectRow,
  PushJobMessage
} from "./types.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

export type { CreateEventInput } from "./event-contract.js"

export interface EventPage {
  readonly events: ReadonlyArray<EventView>
  readonly next_cursor?: string | undefined
}

export type EventError = InvalidEvent | InvalidEventQuery | EventNotFound |
  RepositoryUnavailable | QueueUnavailable | CryptographyUnavailable

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

const isStoredAction = (value: unknown): value is EventAction =>
  typeof value === "object" && value !== null &&
  typeof (value as { readonly label?: unknown }).label === "string" &&
  typeof (value as { readonly url?: unknown }).url === "string"

const parseActions = (value: string): ReadonlyArray<EventAction> => {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(isStoredAction).slice(0, 3) : []
  } catch {
    return []
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
  actions: parseActions(row.actions_json),
  occurred_at: row.occurred_at,
  created_at: row.created_at,
  silenced: row.silence_id !== null,
  ...(row.silence_id ? { silence_id: row.silence_id } : {}),
  ...(row.fingerprint && row.group_count !== undefined
    ? {
        group: {
          count: Number(row.group_count),
          first_seen: row.group_first_seen ?? row.created_at,
          last_seen: row.group_last_seen ?? row.created_at
        }
      }
    : {})
})

export const getEvent = (id: string): Effect.Effect<EventView, EventNotFound | RepositoryUnavailable, EventsRepository> =>
  Effect.gen(function*() {
    const events = yield* EventsRepository
    const row = yield* events.findById(id)
    if (!row) return yield* Effect.fail(eventNotFound())
    return toEventView(row)
  })

export const createEventForProject = (
  project: ProjectRow,
  input: CreateEventInput
): Effect.Effect<EventView, EventError, EventsRepository | DeliveriesRepository | PushQueue | AppConfig | CredentialCrypto | SettingsRepository | SilencesRepository | SubscriptionsRepository> =>
  Effect.gen(function*() {
    const events = yield* EventsRepository
    const queue = yield* PushQueue
    const createdAt = nowIso()
    const normalized = yield* decodeCreateEventInput(input)

    if (normalized.external_id) {
      const existing = yield* events.findIdByExternalId(project.id, normalized.external_id)
      if (existing) return yield* getEvent(existing)
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

    yield* events.insertWithPushJobs({
      id: eventId,
      externalId: normalized.external_id ?? null,
      projectId: project.id,
      source: normalized.source ?? "",
      type: normalized.type ?? "",
      level: normalized.level ?? "info",
      title: normalized.title,
      body: normalized.body ?? "",
      fingerprint: normalized.fingerprint ?? "",
      payloadJson: JSON.stringify(data),
      actionsJson: JSON.stringify(normalized.actions ?? []),
      occurredAt: normalized.occurred_at ?? createdAt,
      createdAt,
      silenceId
    }, subscriptions.map((subscription) => subscription.id))

    if (messages.length > 0) {
      const published = yield* queue.sendMany(messages).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false))
      )
      if (published) {
        const queuedAt = nowIso()
        yield* events.markPushJobsQueued(eventId, queuedAt, true)
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

const normalizeFilterTime = (value: string, name: "since" | "until"): string => {
  if (!rfc3339.test(value)) throw invalidEventQuery(`${name} must be an RFC 3339 timestamp`)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw invalidEventQuery(`${name} must be an RFC 3339 timestamp`)
  return date.toISOString()
}

interface SearchPart {
  readonly value: string
  readonly prefix: boolean
}

export const compileEventSearchQuery = (input: string): string => {
  if (input.length > 240) throw invalidEventQuery("search must be at most 240 characters")
  if (input.includes("\0")) throw invalidEventQuery("search must not contain NUL characters")

  const parts: Array<SearchPart> = []
  let offset = 0

  while (offset < input.length) {
    while (/\s/u.test(input[offset] ?? "")) offset += 1
    if (offset >= input.length) break

    if (input[offset] === '"') {
      offset += 1
      let value = ""
      let closed = false
      while (offset < input.length) {
        const character = input[offset] ?? ""
        if (character === "\\" && input[offset + 1] === '"') {
          value += '"'
          offset += 2
          continue
        }
        if (character === '"') {
          closed = true
          offset += 1
          break
        }
        value += character
        offset += 1
      }
      if (!closed) throw invalidEventQuery("search phrase has an unterminated quote")
      if (value.trim()) parts.push({ value: value.trim(), prefix: false })
      continue
    }

    const start = offset
    while (offset < input.length && !/\s/u.test(input[offset] ?? "")) offset += 1
    const raw = input.slice(start, offset)
    const prefix = raw.endsWith("*")
    const value = (prefix ? raw.slice(0, -1) : raw).trim()
    if (value) parts.push({ value, prefix })
  }

  if (parts.length === 0) throw invalidEventQuery("search must contain a token")
  return parts.map(({ value, prefix }) => {
    const phrase = `"${value.replaceAll('"', '""')}"`
    return prefix ? `${phrase}*` : phrase
  }).join(" AND ")
}

export interface ListEventsInput {
  readonly project?: string | undefined
  readonly level?: string | undefined
  readonly source?: string | undefined
  readonly fingerprint?: string | undefined
  readonly search?: string | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
  readonly grouped?: string | undefined
  readonly silenced?: string | undefined
  readonly before?: string | undefined
  readonly limit?: string | undefined
}

export const listEvents = (
  input: ListEventsInput
): Effect.Effect<EventPage, InvalidEventQuery | RepositoryUnavailable, EventsRepository> =>
  Effect.gen(function*() {
    const events = yield* EventsRepository

    if (input.level) {
      if (!isLevel(input.level)) return yield* Effect.fail(invalidEventQuery("level filter is invalid"))
    }
    if (input.silenced !== undefined && input.silenced !== "true" && input.silenced !== "false") {
      return yield* Effect.fail(invalidEventQuery("silenced filter must be true or false"))
    }

    let since: string | undefined
    let until: string | undefined
    try {
      since = input.since ? normalizeFilterTime(input.since, "since") : undefined
      until = input.until ? normalizeFilterTime(input.until, "until") : undefined
    } catch (cause) {
      return yield* Effect.fail(cause as InvalidEventQuery)
    }
    if (since && until && since > until) {
      return yield* Effect.fail(invalidEventQuery("since must not be later than until"))
    }

    if (input.grouped !== undefined && input.grouped !== "true" && input.grouped !== "false") {
      return yield* Effect.fail(invalidEventQuery("grouped filter must be true or false"))
    }
    const grouped = input.grouped === "true"
    const cursor = input.before ? decodeCursor(input.before) : null
    if (input.before && !cursor) return yield* Effect.fail(invalidEventQuery("before cursor is invalid"))

    const requestedLimit = Number.parseInt(input.limit ?? "50", 10)
    const limit = clamp(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1, 100)
    const searchInput = input.search?.trim()
    let searchQuery: string | undefined
    if (searchInput) {
      try {
        searchQuery = compileEventSearchQuery(searchInput)
      } catch (cause) {
        return yield* Effect.fail(cause as InvalidEventQuery)
      }
    }
    const criteria: EventListCriteria = {
      ...(input.project ? { project: input.project } : {}),
      ...(input.level ? { level: input.level as Level } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
      ...(searchQuery ? { searchQuery } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(input.silenced !== undefined ? { silenced: input.silenced === "true" } : {}),
      grouped,
      ...(cursor ? { cursor } : {}),
      limit: limit + 1
    }
    const rows = yield* events.list(criteria)

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
): Effect.Effect<ReadonlyArray<DeliveryRow>, EventNotFound | RepositoryUnavailable, EventsRepository | DeliveriesRepository> =>
  Effect.gen(function*() {
    const deliveries = yield* DeliveriesRepository
    yield* getEvent(eventId)
    return yield* deliveries.listForEvent(eventId)
  })

export const unsilenceEvent = (
  eventId: string
): Effect.Effect<{ readonly event: EventView; readonly deliveries: ReadonlyArray<DeliveryRow> }, EventNotFound | RepositoryUnavailable | QueueUnavailable, EventsRepository | DeliveriesRepository | SubscriptionsRepository | PushQueue> =>
  Effect.gen(function*() {
    const events = yield* EventsRepository
    const queue = yield* PushQueue
    const current = yield* getEvent(eventId)
    if (!current.silenced) {
      return { event: current, deliveries: yield* eventDeliveries(eventId) }
    }

    const subscriptions = yield* listEnabledSubscriptionRows
    const now = nowIso()
    yield* events.unsilenceWithPushJobs(eventId, subscriptions.map((subscription) => subscription.id), now)

    const messages = subscriptions.map((subscription) => ({ eventId, subscriptionId: subscription.id }))
    if (messages.length > 0) {
      const published = yield* queue.sendMany(messages).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false))
      )
      if (published) {
        const queuedAt = nowIso()
        yield* events.markPushJobsQueued(eventId, queuedAt, false)
      }
    }

    return {
      event: yield* getEvent(eventId),
      deliveries: yield* eventDeliveries(eventId)
    }
  })
