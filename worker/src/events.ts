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
import { AppConfig, CredentialCrypto, Database, PushQueue } from "./services.js"
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

const eventColumns = `
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
    e.actions_json,
    e.occurred_at,
    e.created_at,
    e.silence_id
`

const eventSelect = `
  SELECT ${eventColumns}
  FROM events e
  JOIN projects p ON p.id = e.project_id
`

export const getEvent = (id: string): Effect.Effect<EventView, EventNotFound | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const row = yield* db.first<EventRow>(
      "events.get_by_id_or_alias",
      `${eventSelect}
       WHERE e.id = COALESCE(
         (SELECT event_id FROM event_aliases WHERE alias_id = ?),
         ?
       )`,
      [id, id]
    )
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
): Effect.Effect<EventAccepted, EventError, Database | PushQueue | CredentialCrypto | AppConfig> =>
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
      const db = yield* Database
      const existing = yield* db.first<{ readonly id: string }>(
        "SELECT id FROM events WHERE project_id = ? AND external_id = ?",
        [project.id, normalized.external_id]
      ).pipe(
        // Preserve IDs created by pre-Queue releases when D1 is healthy, but
        // never make durable Queue acceptance depend on this compatibility read.
        Effect.catchTag("RepositoryUnavailable", () => Effect.succeed(null))
      )
      eventId = existing?.id ?? (yield* idempotentEventId(project.id, normalized.external_id))
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

interface PendingPushJob {
  readonly subscription_id: string
}

const publishPendingPushJobs = (
  eventId: string
): Effect.Effect<void, RepositoryUnavailable | QueueUnavailable, Database | PushQueue> =>
  Effect.gen(function*() {
    const db = yield* Database
    const queue = yield* PushQueue
    const pending = yield* db.all<PendingPushJob>(
      "push_jobs.list_pending_for_publication",
      "SELECT subscription_id FROM push_jobs WHERE event_id = ? AND state = 'pending' ORDER BY subscription_id",
      [eventId]
    )
    for (const job of pending) {
      yield* queue.send({
        _tag: "DeliverPush",
        version: QUEUE_COMMAND_VERSION,
        eventId,
        subscriptionId: job.subscription_id
      })
      const queuedAt = nowIso()
      yield* db.run(
        "push_jobs.mark_queued",
        `UPDATE push_jobs SET state = 'queued', queued_at = ?, updated_at = ?
         WHERE event_id = ? AND subscription_id = ? AND state = 'pending'`,
        [queuedAt, queuedAt, eventId, job.subscription_id]
      )
    }
  })

export const processIngestEvent = (
  command: IngestEventCommand
): Effect.Effect<void, EventError, Database | PushQueue | AppConfig> =>
  Effect.gen(function*() {
    const db = yield* Database
    const project = yield* db.first<ProjectRow>(
      "projects.get_for_ingestion",
      "SELECT * FROM projects WHERE id = ?",
      [command.projectId]
    )
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
    yield* db.batch("events.initialize_ingestion_fanout", [
      {
        name: "events.insert_ingested",
        sql: `INSERT OR IGNORE INTO events
          (id, external_id, project_id, source, type, level, title, body, fingerprint,
           payload_json, actions_json, occurred_at, created_at, silence_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          command.eventId,
          normalized.external_id ?? null,
          project.id,
          normalized.source ?? "",
          normalized.type ?? "",
          normalized.level ?? "info",
          normalized.title,
          normalized.body ?? "",
          normalized.fingerprint ?? "",
          JSON.stringify(data),
          JSON.stringify(normalized.actions ?? []),
          normalized.occurred_at ?? command.acceptedAt,
          command.acceptedAt,
          silenceId
        ]
      },
      ...subscriptions.map((subscription) => ({
        name: "push_jobs.create_pending",
        sql: `INSERT OR IGNORE INTO push_jobs
          (event_id, subscription_id, state, attempts, available_at, queued_at,
           lease_until, dead_at, last_error, updated_at)
          SELECT ?, ?, 'pending', 0, ?, NULL, NULL, NULL, '', ?
          WHERE EXISTS (
            SELECT 1 FROM events WHERE id = ? AND fanout_completed_at IS NULL
          )`,
        params: [
          command.eventId,
          subscription.id,
          command.acceptedAt,
          command.acceptedAt,
          command.eventId
        ]
      })),
      {
        name: "events.mark_fanout_complete",
        sql: `UPDATE events SET fanout_completed_at = ?
              WHERE id = ? AND fanout_completed_at IS NULL`,
        params: [command.acceptedAt, command.eventId]
      }
    ])

    const stored = normalized.external_id
      ? yield* db.first<{ readonly id: string }>(
          "events.get_ingested_by_external_id",
          "SELECT id FROM events WHERE project_id = ? AND external_id = ?",
          [project.id, normalized.external_id]
        )
      : yield* db.first<{ readonly id: string }>(
          "events.get_ingested_by_id",
          "SELECT id FROM events WHERE id = ?",
          [command.eventId]
        )
    if (!stored) return yield* Effect.fail(eventNotFound("ingested event could not be loaded"))

    if (stored.id !== command.eventId) {
      yield* db.run(
        "event_aliases.insert",
        `INSERT OR IGNORE INTO event_aliases (alias_id, event_id, created_at)
         VALUES (?, ?, ?)`,
        [command.eventId, stored.id, command.acceptedAt]
      )
    }

    yield* publishPendingPushJobs(stored.id)
  }).pipe(Effect.withSpan("EventIngestion.process", { attributes: { eventId: command.eventId } }))

export const processIngestDeadLetter = (
  command: IngestEventCommand
): Effect.Effect<void, EventError, Database | PushQueue | AppConfig> =>
  processIngestEvent(command).pipe(
    Effect.catch((failure) =>
      Effect.gen(function*() {
        const db = yield* Database
        const failedAt = nowIso()
        const reason = `ingestion exhausted Queue retries: ${failure.message}`.slice(0, 4_000)
        yield* db.batch("ingestion_failures.record_terminal", [
          {
            name: "push_jobs.terminalize_ingestion_failure",
            sql: `UPDATE push_jobs
                  SET state = 'dead', lease_until = NULL, dead_at = ?,
                      last_error = ?, updated_at = ?
                  WHERE event_id = ? AND state = 'pending'`,
            params: [failedAt, reason, failedAt, command.eventId]
          },
          {
            name: "ingestion_failures.upsert",
            sql: `INSERT INTO ingestion_failures
                  (event_id, project_id, external_id, error, failed_at)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(event_id) DO UPDATE SET
                    error = excluded.error, failed_at = excluded.failed_at`,
            params: [
              command.eventId,
              command.projectId,
              command.event.external_id ?? null,
              reason,
              failedAt
            ]
          }
        ])
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
): Effect.Effect<EventPage, InvalidEventQuery | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const conditions: Array<string> = []
    const params: Array<unknown> = []

    if (input.project) {
      conditions.push("e.project_id = ?")
      params.push(input.project)
    }
    if (input.level) {
      if (!isLevel(input.level)) return yield* Effect.fail(invalidEventQuery("level filter is invalid"))
      conditions.push("e.level = ?")
      params.push(input.level)
    }
    if (input.source) {
      conditions.push("e.source = ?")
      params.push(input.source)
    }
    if (input.fingerprint) {
      conditions.push("e.fingerprint = ?")
      params.push(input.fingerprint)
    }
    if (input.search) {
      const search = input.search.trim().slice(0, 240)
      if (search) {
        const pattern = `%${search}%`
        conditions.push(
          "(e.title LIKE ? OR e.body LIKE ? OR e.source LIKE ? OR e.fingerprint LIKE ? OR e.payload_json LIKE ?)"
        )
        params.push(pattern, pattern, pattern, pattern, pattern)
      }
    }
    if (input.silenced !== undefined && input.silenced !== "true" && input.silenced !== "false") {
      return yield* Effect.fail(invalidEventQuery("silenced filter must be true or false"))
    }
    if (input.silenced === "true") conditions.push("e.silence_id IS NOT NULL")
    if (input.silenced === "false") conditions.push("e.silence_id IS NULL")

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
    if (since) {
      conditions.push("e.created_at >= ?")
      params.push(since)
    }
    if (until) {
      conditions.push("e.created_at <= ?")
      params.push(until)
    }

    if (input.grouped !== undefined && input.grouped !== "true" && input.grouped !== "false") {
      return yield* Effect.fail(invalidEventQuery("grouped filter must be true or false"))
    }
    const grouped = input.grouped === "true"
    const cursor = input.before ? decodeCursor(input.before) : null
    if (input.before && !cursor) return yield* Effect.fail(invalidEventQuery("before cursor is invalid"))

    const requestedLimit = Number.parseInt(input.limit ?? "50", 10)
    const limit = clamp(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1, 100)

    let rows: ReadonlyArray<EventRow>
    if (grouped) {
      const queryParams = [...params, ...params]
      let outerCursor = ""
      if (cursor) {
        outerCursor = "AND (created_at < ? OR (created_at = ? AND id < ?))"
        queryParams.push(cursor.createdAt, cursor.createdAt, cursor.id)
      }
      queryParams.push(limit + 1)
      const fingerprintedConditions = [...conditions, "e.fingerprint <> ''"]
      const ungroupedConditions = [...conditions, "e.fingerprint = ''"]
      rows = yield* db.all<EventRow>(
        "events.list_grouped",
        `WITH fingerprinted AS (
           SELECT ${eventColumns},
             COUNT(*) OVER (
               PARTITION BY e.project_id, e.fingerprint
             ) AS group_count,
             MIN(e.created_at) OVER (
               PARTITION BY e.project_id, e.fingerprint
             ) AS group_first_seen,
             MAX(e.created_at) OVER (
               PARTITION BY e.project_id, e.fingerprint
             ) AS group_last_seen,
             ROW_NUMBER() OVER (
               PARTITION BY e.project_id, e.fingerprint
               ORDER BY e.created_at DESC, e.id DESC
             ) AS group_rank
           FROM events e
           JOIN projects p ON p.id = e.project_id
           WHERE ${fingerprintedConditions.join(" AND ")}
         ), representatives AS (
           SELECT * FROM fingerprinted WHERE group_rank = 1
           UNION ALL
           SELECT ${eventColumns},
             1 AS group_count,
             e.created_at AS group_first_seen,
             e.created_at AS group_last_seen,
             1 AS group_rank
           FROM events e
           JOIN projects p ON p.id = e.project_id
           WHERE ${ungroupedConditions.join(" AND ")}
         )
         SELECT * FROM representatives
         WHERE 1 = 1 ${outerCursor}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        queryParams
      )
    } else {
      const queryParams = [...params]
      const cursorCondition = cursor
        ? "(e.created_at < ? OR (e.created_at = ? AND e.id < ?))"
        : ""
      if (cursor) queryParams.push(cursor.createdAt, cursor.createdAt, cursor.id)
      queryParams.push(limit + 1)
      const allConditions = [
        ...conditions,
        ...(cursorCondition ? [cursorCondition] : [])
      ]
      rows = yield* db.all<EventRow>(
        "events.list",
        `${eventSelect}
         ${allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : ""}
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ?`,
        queryParams
      )
    }

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
): Effect.Effect<ReadonlyArray<DeliveryRow>, EventNotFound | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const event = yield* getEvent(eventId)
    return yield* db.all<DeliveryRow>(
      "deliveries.list_for_event",
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
      [event.id]
    )
  })

export const unsilenceEvent = (
  eventId: string
): Effect.Effect<{ readonly event: EventView; readonly deliveries: ReadonlyArray<DeliveryRow> }, EventNotFound | RepositoryUnavailable | QueueUnavailable, Database | PushQueue> =>
  Effect.gen(function*() {
    const db = yield* Database
    const current = yield* getEvent(eventId)
    const resolvedEventId = current.id
    if (!current.silenced) {
      yield* publishPendingPushJobs(resolvedEventId)
      return { event: current, deliveries: yield* eventDeliveries(resolvedEventId) }
    }

    const subscriptions = yield* listEnabledSubscriptionRows
    const now = nowIso()
    yield* db.batch("events.unsilence_with_push_jobs", [
      {
        name: "events.unsilence",
        sql: "UPDATE events SET silence_id = NULL WHERE id = ?",
        params: [resolvedEventId]
      },
      ...subscriptions.map((subscription) => ({
        name: "push_jobs.upsert_pending",
        sql: `INSERT INTO push_jobs
          (event_id, subscription_id, state, attempts, available_at, queued_at, lease_until, last_error, updated_at)
          VALUES (?, ?, 'pending', 0, ?, NULL, NULL, '', ?)
          ON CONFLICT(event_id, subscription_id) DO UPDATE SET
            state = 'pending', available_at = excluded.available_at, queued_at = NULL,
            lease_until = NULL, dead_at = NULL, last_error = '', updated_at = excluded.updated_at`,
        params: [resolvedEventId, subscription.id, now, now]
      }))
    ])

    yield* publishPendingPushJobs(resolvedEventId)

    return {
      event: yield* getEvent(resolvedEventId),
      deliveries: yield* eventDeliveries(resolvedEventId)
    }
  })
