import { Effect } from "effect"
import { decodeCreateEventInput, type CreateEventInput } from "./event-contract.js"
import {
  eventNotFound,
  invalidEvent,
  invalidEventQuery,
  projectNotFound,
  type CryptographyUnavailable,
  type EventNotFound,
  type InvalidEvent,
  type InvalidEventQuery,
  type ProjectNotFound,
  type QueueUnavailable,
  type RepositoryUnavailable
} from "./errors.js"
import { base64UrlDecode, base64UrlEncode, sha256Hex } from "./crypto.js"
import { clamp, newId, nowIso } from "./ids.js"
import { atLeast, isLevel } from "./levels.js"
import { redactValue } from "./redact.js"
import {
  DeliveriesRepository,
  EventsRepository,
  ProjectsRepository,
  SettingsRepository,
  SilencesRepository,
  SubscriptionsRepository,
  type EventListCriteria
} from "./repositories.js"
import { AppConfig, CredentialCrypto, PushQueue } from "./services.js"
import { getSettings } from "./settings.js"
import { matchSilence } from "./silences.js"
import { listEnabledSubscriptionRows } from "./subscriptions.js"
import {
  encodedQueueCommandBytes,
  QUEUE_COMMAND_MAX_BYTES,
  QUEUE_COMMAND_VERSION,
  type IngestEventCommand
} from "./queue-contract.js"
import type {
  DeliveryRow,
  EventAction,
  EventRow,
  EventView,
  Level,
  ProjectRow
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
  ProjectNotFound | RepositoryUnavailable | QueueUnavailable | CryptographyUnavailable

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

export interface EventAccepted {
  readonly id: string
  readonly accepted_at: string
  readonly status: "queued"
}

const idempotentEventId = (
  projectId: string,
  externalId: string
): Effect.Effect<string, CryptographyUnavailable, CredentialCrypto> =>
  sha256Hex(`${projectId}\u0000${externalId}`).pipe(
    Effect.map((digest) => `evt_${digest.slice(0, 32)}`)
  )

export const enqueueEventForProject = (
  project: ProjectRow,
  input: CreateEventInput
): Effect.Effect<EventAccepted, EventError, EventsRepository | SettingsRepository | PushQueue | CredentialCrypto | AppConfig> =>
  Effect.gen(function*() {
    const queue = yield* PushQueue
    const normalized = yield* decodeCreateEventInput(input)
    let queuedEvent = normalized
    if (normalized.data !== undefined) {
      const settings = yield* getSettings
      const redacted = redactValue(normalized.data, settings.redact_keys)
      queuedEvent = {
        ...normalized,
        data: typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)
          ? redacted as Record<string, unknown>
          : {}
      }
    }
    const acceptedAt = nowIso()
    let eventId: string
    if (normalized.external_id) {
      const events = yield* EventsRepository
      const existing = yield* events.findIdByExternalId(project.id, normalized.external_id).pipe(
        // Preserve IDs created by pre-Queue releases when D1 is healthy, but
        // never make durable Queue acceptance depend on this compatibility read.
        Effect.catchTag("RepositoryUnavailable", () => Effect.succeed(null))
      )
      eventId = existing ?? (yield* idempotentEventId(project.id, normalized.external_id))
    } else {
      eventId = yield* newId("evt")
    }
    const command: IngestEventCommand = {
      _tag: "IngestEvent",
      version: QUEUE_COMMAND_VERSION,
      eventId,
      projectId: project.id,
      acceptedAt,
      event: queuedEvent
    }
    if (encodedQueueCommandBytes(command) > QUEUE_COMMAND_MAX_BYTES) {
      return yield* Effect.fail(invalidEvent("event is too large for durable Queue acceptance"))
    }
    yield* queue.send(command)
    return { id: eventId, accepted_at: acceptedAt, status: "queued" }
  })

const publishPendingPushJobs = (
  eventId: string
): Effect.Effect<void, RepositoryUnavailable | QueueUnavailable, EventsRepository | PushQueue> =>
  Effect.gen(function*() {
    const events = yield* EventsRepository
    const queue = yield* PushQueue
    const pending = yield* events.listPendingSubscriptionIds(eventId)
    for (const subscriptionId of pending) {
      yield* queue.send({
        _tag: "DeliverPush",
        version: QUEUE_COMMAND_VERSION,
        eventId,
        subscriptionId
      })
      const queuedAt = nowIso()
      yield* events.markPushJobQueued(eventId, subscriptionId, queuedAt)
    }
  })

export const processIngestEvent = (
  command: IngestEventCommand
): Effect.Effect<void, EventError, ProjectsRepository | EventsRepository | SettingsRepository | SilencesRepository | SubscriptionsRepository | PushQueue | AppConfig> =>
  Effect.gen(function*() {
    const projects = yield* ProjectsRepository
    const events = yield* EventsRepository
    const project = yield* projects.findById(command.projectId)
    if (!project) return yield* Effect.fail(projectNotFound("ingest project no longer exists"))

    const normalized = command.event
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
    const shouldNotify = project.notify === 1 &&
      atLeast(normalized.level ?? "info", project.min_level) && !silenceId
    const subscriptions = shouldNotify ? yield* listEnabledSubscriptionRows : []
    yield* events.initializeIngestion({
      id: command.eventId,
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
      occurredAt: normalized.occurred_at ?? command.acceptedAt,
      createdAt: command.acceptedAt,
      silenceId
    }, subscriptions.map((subscription) => ({
      id: subscription.id,
      generation: subscription.enrollment_generation
    })))

    const stored = normalized.external_id
      ? yield* events.findIdByExternalId(project.id, normalized.external_id)
      : (yield* events.findById(command.eventId))?.id ?? null
    if (!stored) return yield* Effect.fail(eventNotFound("ingested event could not be loaded"))

    if (stored !== command.eventId) {
      yield* events.insertAlias(command.eventId, stored, command.acceptedAt)
    }

    yield* publishPendingPushJobs(stored)
  }).pipe(Effect.withSpan("EventIngestion.process", { attributes: { eventId: command.eventId } }))

export const processIngestDeadLetter = (
  command: IngestEventCommand
): Effect.Effect<void, EventError, ProjectsRepository | EventsRepository | SettingsRepository | SilencesRepository | SubscriptionsRepository | PushQueue | AppConfig> =>
  processIngestEvent(command).pipe(
    Effect.catch((failure) =>
      Effect.gen(function*() {
        const events = yield* EventsRepository
        const failedAt = nowIso()
        const reason = `ingestion exhausted Queue retries: ${failure.message}`.slice(0, 4_000)
        yield* events.recordIngestionFailure({
          eventId: command.eventId,
          projectId: command.projectId,
          externalId: command.event.external_id ?? null,
          reason,
          failedAt
        })
      })
    )
  ).pipe(Effect.withSpan("EventIngestion.deadLetter", { attributes: { eventId: command.eventId } }))

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

    const search = input.search?.trim().slice(0, 240)
    const criteria: EventListCriteria = {
      ...(input.project ? { project: input.project } : {}),
      ...(input.level ? { level: input.level as Level } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
      ...(search ? { search } : {}),
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
    const event = yield* getEvent(eventId)
    return yield* deliveries.listForEvent(event.id)
  })

export const unsilenceEvent = (
  eventId: string
): Effect.Effect<{ readonly event: EventView; readonly deliveries: ReadonlyArray<DeliveryRow> }, EventNotFound | RepositoryUnavailable | QueueUnavailable, EventsRepository | DeliveriesRepository | SubscriptionsRepository | PushQueue> =>
  Effect.gen(function*() {
    const events = yield* EventsRepository
    const current = yield* getEvent(eventId)
    const resolvedEventId = current.id
    if (!current.silenced) {
      yield* publishPendingPushJobs(resolvedEventId)
      return { event: current, deliveries: yield* eventDeliveries(resolvedEventId) }
    }

    const subscriptions = yield* listEnabledSubscriptionRows
    const now = nowIso()
    yield* events.unsilenceWithPushJobs(resolvedEventId, subscriptions.map((subscription) => ({
      id: subscription.id,
      generation: subscription.enrollment_generation
    })), now)

    yield* publishPendingPushJobs(resolvedEventId)

    return {
      event: yield* getEvent(resolvedEventId),
      deliveries: yield* eventDeliveries(resolvedEventId)
    }
  })
