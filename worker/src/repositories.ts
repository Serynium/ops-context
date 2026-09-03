import { Context, Effect, Layer, Schema } from "effect"
import { repositoryUnavailable, type RepositoryUnavailable } from "./errors.js"
import {
  rebuildEventGroupsByLevelSql,
  rebuildEventGroupsSql
} from "./event-groups.js"
import { Database } from "./services.js"
import type { SilenceField } from "./silences.js"
import type { Level } from "./types.js"

const nullableString = Schema.NullOr(Schema.String)
const LevelSchema = Schema.Literals(["info", "success", "warning", "error", "critical"])

const validJsonObject = (value: string): boolean => {
  try {
    const decoded: unknown = JSON.parse(value)
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
  } catch {
    return false
  }
}

const validActionsJson = (value: string): boolean => {
  try {
    const decoded: unknown = JSON.parse(value)
    return Array.isArray(decoded) && decoded.length <= 3 && decoded.every((entry) =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as { readonly label?: unknown }).label === "string" &&
      typeof (entry as { readonly url?: unknown }).url === "string"
    )
  } catch {
    return false
  }
}

export const ProjectRowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  icon: Schema.String,
  api_key_hash: Schema.String,
  notify: Schema.Number,
  min_level: LevelSchema,
  created_at: Schema.String,
  updated_at: Schema.String
})

export const EventRowSchema = Schema.Struct({
  id: Schema.String,
  external_id: nullableString,
  project_id: Schema.String,
  project_name: Schema.String,
  project_slug: Schema.String,
  project_icon: Schema.String,
  source: Schema.String,
  type: Schema.String,
  level: LevelSchema,
  title: Schema.String,
  body: Schema.String,
  fingerprint: Schema.String,
  payload_json: Schema.String.pipe(Schema.refine((value): value is string => validJsonObject(value), { message: "payload_json must contain a JSON object" })),
  actions_json: Schema.String.pipe(Schema.refine((value): value is string => validActionsJson(value), { message: "actions_json must contain valid event actions" })),
  occurred_at: Schema.String,
  created_at: Schema.String,
  silence_id: nullableString,
  group_count: Schema.optional(Schema.Number),
  group_first_seen: Schema.optional(Schema.String),
  group_last_seen: Schema.optional(Schema.String)
})

export const PushSubscriptionRowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  user_agent: Schema.String,
  enabled: Schema.Number,
  last_seen_at: nullableString,
  renewal_credential_hash: nullableString,
  renewal_credential_issued_at: nullableString,
  previous_renewal_credential_hash: nullableString,
  previous_renewal_credential_valid_until: nullableString,
  explicitly_enrolled: Schema.Number,
  deleted_at: nullableString,
  enrollment_generation: Schema.Number,
  created_at: Schema.String,
  updated_at: Schema.String
})

export const SilenceRowSchema = Schema.Struct({
  id: Schema.String,
  project_id: nullableString,
  project_name: nullableString,
  field: Schema.Literals(["fingerprint", "title", "source"]),
  value: Schema.String,
  note: Schema.String,
  created_at: Schema.String
})

export const DeliveryRowSchema = Schema.Struct({
  id: Schema.String,
  event_id: Schema.String,
  subscription_id: Schema.String,
  subscription_name: Schema.String,
  status: Schema.Literals(["sent", "failed", "skipped"]),
  response_status: Schema.NullOr(Schema.Number),
  error: Schema.String,
  attempted_at: Schema.String
})

export type ProjectRow = typeof ProjectRowSchema.Type
export type EventRow = typeof EventRowSchema.Type
export type PushSubscriptionRow = typeof PushSubscriptionRowSchema.Type
export type SilenceRow = typeof SilenceRowSchema.Type
export type DeliveryRow = typeof DeliveryRowSchema.Type

export interface ProjectInsert {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly icon: string
  readonly apiKeyHash: string
  readonly createdAt: string
}

export interface ProjectListCriteria {
  readonly cursor?: { readonly name: string; readonly id: string }
  readonly limit: number
}

export class ProjectsRepository extends Context.Service<ProjectsRepository, {
  readonly list: (criteria: ProjectListCriteria) => Effect.Effect<ReadonlyArray<ProjectRow>, RepositoryUnavailable>
  readonly findById: (id: string) => Effect.Effect<ProjectRow | null, RepositoryUnavailable>
  readonly findFirst: Effect.Effect<ProjectRow | null, RepositoryUnavailable>
  readonly findByApiKeyHash: (hash: string) => Effect.Effect<ProjectRow | null, RepositoryUnavailable>
  readonly slugExists: (slug: string) => Effect.Effect<boolean, RepositoryUnavailable>
  readonly insert: (project: ProjectInsert) => Effect.Effect<void, RepositoryUnavailable>
  readonly update: (id: string, values: { readonly name: string; readonly icon: string; readonly notify: number; readonly minLevel: Level; readonly updatedAt: string }) => Effect.Effect<void, RepositoryUnavailable>
  readonly delete: (id: string) => Effect.Effect<void, RepositoryUnavailable>
  readonly rotateApiKey: (id: string, hash: string, updatedAt: string) => Effect.Effect<void, RepositoryUnavailable>
}>()("ops-context/ProjectsRepository") {
  static readonly layer = Layer.effect(ProjectsRepository, Effect.gen(function*() {
    const db = yield* Database
    const Id = Schema.Struct({ id: Schema.String })
    return ProjectsRepository.of({
      list: (criteria) => db.all(
        ProjectRowSchema,
        `SELECT * FROM projects
         ${criteria.cursor
           ? "WHERE name COLLATE NOCASE > ? COLLATE NOCASE OR (name = ? COLLATE NOCASE AND id > ?)"
           : ""}
         ORDER BY name COLLATE NOCASE, id
         LIMIT ?`,
        criteria.cursor
          ? [criteria.cursor.name, criteria.cursor.name, criteria.cursor.id, criteria.limit]
          : [criteria.limit],
        "projects.list"
      ),
      findById: (id) => db.first(ProjectRowSchema, "SELECT * FROM projects WHERE id = ?", [id], "projects.get_by_id"),
      findFirst: db.first(ProjectRowSchema, "SELECT * FROM projects ORDER BY created_at LIMIT 1", [], "projects.get_first"),
      findByApiKeyHash: (hash) => db.first(ProjectRowSchema, "SELECT * FROM projects WHERE api_key_hash = ?", [hash], "projects.get_by_api_key_hash"),
      slugExists: (slug) => db.first(Id, "SELECT id FROM projects WHERE slug = ?", [slug], "projects.get_by_slug").pipe(Effect.map(Boolean)),
      insert: (project) => db.run(
        `INSERT INTO projects
         (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'warning', ?, ?)`,
        [project.id, project.name, project.slug, project.icon, project.apiKeyHash, project.createdAt, project.createdAt],
        "projects.create"
      ).pipe(Effect.asVoid),
      update: (id, values) => db.run(
        "UPDATE projects SET name = ?, icon = ?, notify = ?, min_level = ?, updated_at = ? WHERE id = ?",
        [values.name, values.icon, values.notify, values.minLevel, values.updatedAt, id],
        "projects.update"
      ).pipe(Effect.asVoid),
      delete: (id) => db.run("DELETE FROM projects WHERE id = ?", [id], "projects.delete").pipe(Effect.asVoid),
      rotateApiKey: (id, hash, updatedAt) => db.run(
        "UPDATE projects SET api_key_hash = ?, updated_at = ? WHERE id = ?", [hash, updatedAt, id],
        "projects.rotate_api_key"
      ).pipe(Effect.asVoid)
    })
  }))
}

export interface EventListCriteria {
  readonly project?: string
  readonly level?: Level
  readonly source?: string
  readonly fingerprint?: string
  readonly searchQuery?: string
  readonly since?: string
  readonly until?: string
  readonly silenced?: boolean
  readonly grouped: boolean
  readonly cursor?: { readonly createdAt: string; readonly id: string }
  readonly limit: number
}

export interface EventInsert {
  readonly id: string
  readonly externalId: string | null
  readonly projectId: string
  readonly source: string
  readonly type: string
  readonly level: Level
  readonly title: string
  readonly body: string
  readonly fingerprint: string
  readonly payloadJson: string
  readonly actionsJson: string
  readonly occurredAt: string
  readonly createdAt: string
  readonly silenceId: string | null
  readonly notificationCutoff: string | null
}

export const pruneEventsBeforeSql = `DELETE FROM events
WHERE id IN (
  SELECT id FROM events
  WHERE created_at_ms < ?
  ORDER BY created_at_ms ASC, id ASC
  LIMIT ?
)`

export const pruneTerminalPushJobsBeforeSql = `DELETE FROM push_jobs
WHERE rowid IN (
  SELECT rowid FROM push_jobs INDEXED BY push_jobs_terminal_updated
  WHERE state IN ('sent', 'dead') AND updated_at < ?
  ORDER BY updated_at, event_id, subscription_id
  LIMIT ?
)`

export const pruneSuccessfulDeliveriesBeforeEventSql = `DELETE FROM deliveries
WHERE id IN (
  SELECT d.id
  FROM events e INDEXED BY events_created_at
  JOIN deliveries d INDEXED BY deliveries_event_id ON d.event_id = e.id
  WHERE e.created_at_ms < ? AND d.status = 'sent'
  ORDER BY e.created_at_ms, e.id
  LIMIT ?
)`

export interface SubscriptionFanoutTarget {
  readonly id: string
  readonly generation: number
}

const eventColumns = `
  e.id, e.external_id, e.project_id,
  p.name AS project_name, p.slug AS project_slug, p.icon AS project_icon,
  e.source, e.type, e.level, e.title, e.body, e.fingerprint,
  e.payload_json, e.actions_json, e.occurred_at, e.created_at, e.silence_id`
const eventSelect = `SELECT ${eventColumns} FROM events e JOIN projects p ON p.id = e.project_id`
const epochMs = (value: string): number => Date.parse(value)

export class EventsRepository extends Context.Service<EventsRepository, {
  readonly findById: (id: string) => Effect.Effect<EventRow | null, RepositoryUnavailable>
  readonly findIdByExternalId: (projectId: string, externalId: string) => Effect.Effect<string | null, RepositoryUnavailable>
  readonly list: (criteria: EventListCriteria) => Effect.Effect<ReadonlyArray<EventRow>, RepositoryUnavailable>
  readonly initializeIngestion: (event: EventInsert, subscriptions: ReadonlyArray<SubscriptionFanoutTarget>) => Effect.Effect<void, RepositoryUnavailable>
  readonly insertAlias: (aliasId: string, eventId: string, createdAt: string) => Effect.Effect<void, RepositoryUnavailable>
  readonly listPendingSubscriptionIds: (eventId: string) => Effect.Effect<ReadonlyArray<string>, RepositoryUnavailable>
readonly markFanoutPublished: (eventId: string, publishedAt: string) => Effect.Effect<void, RepositoryUnavailable>
  readonly recordIngestionFailure: (values: {
    readonly eventId: string
    readonly projectId: string
    readonly externalId: string | null
    readonly reason: string
    readonly failedAt: string
  }) => Effect.Effect<void, RepositoryUnavailable>
  readonly unsilenceWithPushJobs: (eventId: string, subscriptions: ReadonlyArray<SubscriptionFanoutTarget>, now: string) => Effect.Effect<void, RepositoryUnavailable>
  readonly pruneTerminalPushJobsBefore: (cutoff: string, limit: number) => Effect.Effect<number, RepositoryUnavailable>
  readonly pruneBefore: (cutoff: string, limit: number) => Effect.Effect<number, RepositoryUnavailable>
  readonly rebuildGroups: Effect.Effect<number, RepositoryUnavailable>
}>()("ops-context/EventsRepository") {
  static readonly layer = Layer.effect(EventsRepository, Effect.gen(function*() {
    const db = yield* Database
    const Id = Schema.Struct({ id: Schema.String })
    const list = (criteria: EventListCriteria) => {
      const conditions: Array<string> = []
      const params: Array<unknown> = []
      const searchJoin = criteria.searchQuery
        ? "JOIN event_search ON event_search.rowid = e.rowid"
        : ""
      if (criteria.project) { conditions.push("e.project_id = ?"); params.push(criteria.project) }
      if (criteria.level) { conditions.push("e.level = ?"); params.push(criteria.level) }
      if (criteria.source) { conditions.push("e.source = ?"); params.push(criteria.source) }
      if (criteria.fingerprint) { conditions.push("e.fingerprint = ?"); params.push(criteria.fingerprint) }
      if (criteria.searchQuery) {
        conditions.push("event_search MATCH ?")
        params.push(criteria.searchQuery)
      }
      if (criteria.silenced === true) conditions.push("e.silence_id IS NOT NULL")
      if (criteria.silenced === false) conditions.push("e.silence_id IS NULL")
      if (criteria.since) { conditions.push("e.created_at_ms >= ?"); params.push(epochMs(criteria.since)) }
      if (criteria.until) { conditions.push("e.created_at_ms <= ?"); params.push(epochMs(criteria.until)) }
      if (criteria.grouped) {
        const supportsReadModel = criteria.source === undefined &&
          criteria.fingerprint === undefined &&
          criteria.searchQuery === undefined &&
          criteria.since === undefined &&
          criteria.until === undefined &&
          criteria.silenced === undefined

        if (supportsReadModel) {
          const queryParams: Array<unknown> = []
          const groupConditions: Array<string> = []
          const eventConditions = ["e.fingerprint = ''"]
          const groupedByLevel = criteria.level !== undefined
          const groupTable = groupedByLevel ? "event_groups_by_level" : "event_groups"
          const emptyFingerprintIndex = groupedByLevel
            ? criteria.project
              ? "events_level_project_empty_fingerprint_created"
              : "events_level_empty_fingerprint_created"
            : criteria.project
              ? "events_project_empty_fingerprint_created"
              : "events_empty_fingerprint_created"

          if (criteria.level) {
            groupConditions.push("g.level = ?")
            queryParams.push(criteria.level)
          }

          if (criteria.project) {
            groupConditions.push("g.project_id = ?")
            queryParams.push(criteria.project)
          }
          if (criteria.cursor) {
            groupConditions.push(
              "(g.last_seen_ms < ? OR (g.last_seen_ms = ? AND g.latest_event_id < ?))"
            )
            queryParams.push(
              epochMs(criteria.cursor.createdAt),
              epochMs(criteria.cursor.createdAt),
              criteria.cursor.id
            )
          }
          queryParams.push(criteria.limit)

          if (criteria.level) {
            eventConditions.push("e.level = ?")
            queryParams.push(criteria.level)
          }
          if (criteria.project) {
            eventConditions.push("e.project_id = ?")
            queryParams.push(criteria.project)
          }
          if (criteria.cursor) {
            eventConditions.push("(e.created_at_ms < ? OR (e.created_at_ms = ? AND e.id < ?))")
            queryParams.push(
              epochMs(criteria.cursor.createdAt),
              epochMs(criteria.cursor.createdAt),
              criteria.cursor.id
            )
          }
          queryParams.push(criteria.limit, criteria.limit)

          return db.all(EventRowSchema, `WITH grouped_representatives AS (
            SELECT ${eventColumns},
              g.occurrence_count AS group_count,
              g.first_seen AS group_first_seen,
              g.last_seen AS group_last_seen
            FROM ${groupTable} g
            JOIN events e ON e.id = g.latest_event_id
            JOIN projects p ON p.id = g.project_id
            ${groupConditions.length > 0 ? `WHERE ${groupConditions.join(" AND ")}` : ""}
            ORDER BY g.last_seen_ms DESC, g.latest_event_id DESC
            LIMIT ?
          ), ungrouped_representatives AS (
            SELECT ${eventColumns},
              1 AS group_count,
              e.created_at AS group_first_seen,
              e.created_at AS group_last_seen
            FROM events e INDEXED BY ${emptyFingerprintIndex}
            JOIN projects p ON p.id = e.project_id
            WHERE ${eventConditions.join(" AND ")}
            ORDER BY e.created_at_ms DESC, e.id DESC
            LIMIT ?
          ), representatives AS (
            SELECT * FROM grouped_representatives
            UNION ALL
            SELECT * FROM ungrouped_representatives
          )
          SELECT * FROM representatives
          ORDER BY created_at DESC, id DESC
          LIMIT ?`, queryParams, groupedByLevel
            ? "events.list_grouped_level_fast"
            : "events.list_grouped_fast")
        }

        const fingerprintedConditions = [...conditions, "e.fingerprint <> ''"]
        const ungroupedConditions = [...conditions, "e.fingerprint = ''"]
        const queryParams = [...params, ...params]
        const outerCursor = criteria.cursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""
        if (criteria.cursor) queryParams.push(criteria.cursor.createdAt, criteria.cursor.createdAt, criteria.cursor.id)
        queryParams.push(criteria.limit)
        return db.all(EventRowSchema, `WITH fingerprinted AS (
          SELECT e.id, e.project_id, e.fingerprint, e.created_at,
            COUNT(*) OVER (PARTITION BY e.project_id, e.fingerprint) AS group_count,
            MIN(e.created_at) OVER (PARTITION BY e.project_id, e.fingerprint) AS group_first_seen,
            MAX(e.created_at) OVER (PARTITION BY e.project_id, e.fingerprint) AS group_last_seen,
            ROW_NUMBER() OVER (PARTITION BY e.project_id, e.fingerprint ORDER BY e.created_at DESC, e.id DESC) AS group_rank
          FROM events e ${searchJoin}
          WHERE ${fingerprintedConditions.join(" AND ")}
        ), representative_ids AS (
          SELECT id, created_at, group_count, group_first_seen, group_last_seen
          FROM fingerprinted WHERE group_rank = 1
          UNION ALL
          SELECT e.id, e.created_at, 1 AS group_count,
            e.created_at AS group_first_seen, e.created_at AS group_last_seen
          FROM events e ${searchJoin}
          WHERE ${ungroupedConditions.join(" AND ")}
        ), page AS (
          SELECT * FROM representative_ids WHERE 1 = 1 ${outerCursor}
          ORDER BY created_at DESC, id DESC LIMIT ?
        ) SELECT ${eventColumns}, page.group_count,
            page.group_first_seen, page.group_last_seen
          FROM page
          JOIN events e ON e.id = page.id
          JOIN projects p ON p.id = e.project_id
          ORDER BY page.created_at DESC, page.id DESC`, queryParams, "events.list_grouped")
      }

      if (criteria.cursor) {
        conditions.push("(e.created_at_ms < ? OR (e.created_at_ms = ? AND e.id < ?))")
        params.push(epochMs(criteria.cursor.createdAt), epochMs(criteria.cursor.createdAt), criteria.cursor.id)
      }
      params.push(criteria.limit)
      return db.all(EventRowSchema, `${eventSelect} ${searchJoin}
        ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY e.created_at_ms DESC, e.id DESC LIMIT ?`, params, "events.list")
    }

    return EventsRepository.of({
      findById: (id) => db.first(EventRowSchema, `${eventSelect}
        WHERE e.id = COALESCE((SELECT event_id FROM event_aliases WHERE alias_id = ?), ?)`,
        [id, id], "events.get_by_id_or_alias"),
      findIdByExternalId: (projectId, externalId) => db.first(
        Id, "SELECT id FROM events WHERE project_id = ? AND external_id = ? LIMIT 1", [projectId, externalId],
        "events.get_by_external_id"
      ).pipe(Effect.map((row) => row?.id ?? null)),
      list,
      initializeIngestion: (event, subscriptions) => db.batch([
        {
          sql: `INSERT OR IGNORE INTO events
            (id, external_id, project_id, source, type, level, title, body, fingerprint,
             payload_json, actions_json, occurred_at, created_at, silence_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [event.id, event.externalId, event.projectId, event.source, event.type, event.level,
            event.title, event.body, event.fingerprint, event.payloadJson, event.actionsJson,
            event.occurredAt, event.createdAt, event.silenceId]
        },
        ...(event.notificationCutoff === null ? [] : [{
          sql: `UPDATE event_groups
                SET last_notified_at = ?, last_notified_event_id = ?
                WHERE project_id = ? AND fingerprint = ?
                  AND (last_notified_at IS NULL OR last_notified_at < ?)
                  AND EXISTS (
                    SELECT 1 FROM events
                    WHERE id = ? AND fanout_completed_at IS NULL
                  )`,
          params: [event.createdAt, event.id, event.projectId, event.fingerprint,
            event.notificationCutoff, event.id]
        }]),
        ...subscriptions.map((subscription) => ({
          sql: `INSERT OR IGNORE INTO push_jobs
            (event_id, subscription_id, subscription_generation, state, attempts,
             available_at, queued_at, lease_until, dead_at, last_error, updated_at)
            SELECT ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, '', ?
            WHERE EXISTS (SELECT 1 FROM events WHERE id = ? AND fanout_completed_at IS NULL)
              AND EXISTS (
                SELECT 1 FROM push_subscriptions
                WHERE id = ? AND enrollment_generation = ?
                  AND enabled = 1 AND deleted_at IS NULL
              )
              AND (
                ? IS NULL OR ? = '' OR EXISTS (
                  SELECT 1 FROM event_groups
                  WHERE project_id = ? AND fingerprint = ?
                    AND last_notified_event_id = ?
                )
              )`,
          params: [event.id, subscription.id, subscription.generation, event.createdAt,
            event.createdAt, event.id, subscription.id, subscription.generation,
            event.notificationCutoff, event.fingerprint, event.projectId,
            event.fingerprint, event.id]
        })),
        {
          sql: "UPDATE events SET fanout_completed_at = ? WHERE id = ? AND fanout_completed_at IS NULL",
          params: [event.createdAt, event.id]
        }
      ], "events.initialize_ingestion_fanout"),
      insertAlias: (aliasId, eventId, createdAt) => db.run(
        "INSERT OR IGNORE INTO event_aliases (alias_id, event_id, created_at) VALUES (?, ?, ?)",
        [aliasId, eventId, createdAt], "event_aliases.insert"
      ).pipe(Effect.asVoid),
      listPendingSubscriptionIds: (eventId) => db.all(
        Schema.Struct({ subscription_id: Schema.String }),
        `SELECT j.subscription_id
         FROM push_jobs j
         JOIN events e ON e.id = j.event_id
         WHERE j.event_id = ? AND j.state = 'pending'
           AND e.fanout_published_at IS NULL
         ORDER BY j.subscription_id`,
        [eventId], "push_jobs.list_pending_for_publication"
      ).pipe(Effect.map((rows) => rows.map((row) => row.subscription_id))),
markFanoutPublished: (eventId, publishedAt) => db.run(
  `UPDATE events SET fanout_published_at = ?
   WHERE id = ? AND fanout_published_at IS NULL`,
  [publishedAt, eventId], "events.mark_fanout_published"
).pipe(Effect.asVoid),
      recordIngestionFailure: (values) => db.batch([
        {
          sql: `UPDATE push_jobs SET state = 'dead', lease_until = NULL, dead_at = ?,
            last_error = ?, updated_at = ? WHERE event_id = ? AND state = 'pending'`,
          params: [values.failedAt, values.reason, values.failedAt, values.eventId]
        },
        {
          sql: `INSERT INTO ingestion_failures (event_id, project_id, external_id, error, failed_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET
            error = excluded.error, failed_at = excluded.failed_at`,
          params: [values.eventId, values.projectId, values.externalId, values.reason, values.failedAt]
        }
      ], "ingestion_failures.record_terminal"),
      unsilenceWithPushJobs: (eventId, subscriptions, now) => db.batch([
        {
  sql: "UPDATE events SET silence_id = NULL, fanout_published_at = NULL WHERE id = ?",
  params: [eventId]
},
        ...subscriptions.map((subscription) => ({
          sql: `INSERT INTO push_jobs
            (event_id, subscription_id, subscription_generation, state, attempts,
             available_at, queued_at, lease_until, last_error, updated_at)
            SELECT ?, ?, ?, 'pending', 0, ?, NULL, NULL, '', ?
            WHERE EXISTS (
              SELECT 1 FROM push_subscriptions
              WHERE id = ? AND enrollment_generation = ?
                AND enabled = 1 AND deleted_at IS NULL
            )
            ON CONFLICT(event_id, subscription_id) DO UPDATE SET
              subscription_generation = excluded.subscription_generation,
              state = 'pending', available_at = excluded.available_at, queued_at = NULL,
              lease_until = NULL, dead_at = NULL, last_error = '', updated_at = excluded.updated_at`,
          params: [eventId, subscription.id, subscription.generation, now, now,
            subscription.id, subscription.generation]
        }))
      ], "events.unsilence_with_push_jobs"),
      pruneTerminalPushJobsBefore: (cutoff, limit) => db.runCounted(
        pruneTerminalPushJobsBeforeSql,
        [cutoff, limit],
        "push_jobs.prune_terminal"
      ),
      pruneBefore: (cutoff, limit) => db.runCounted(
        pruneEventsBeforeSql,
        [epochMs(cutoff), limit],
        "events.prune"
      ),
      rebuildGroups: db.batch([
        { sql: "DELETE FROM event_groups" },
        { sql: rebuildEventGroupsSql },
        { sql: "DELETE FROM event_groups_by_level" },
        { sql: rebuildEventGroupsByLevelSql }
      ], "event_groups.rebuild").pipe(
        Effect.andThen(db.first(
          Schema.Struct({ count: Schema.Number }),
          "SELECT COUNT(*) AS count FROM event_groups",
          [],
          "event_groups.count_after_rebuild"
        )),
        Effect.map((row) => row?.count ?? 0)
      )
    })
  }))
}

interface SubscriptionEnrollmentWrite {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
  readonly userAgent: string
  readonly credentialHash: string
  readonly explicitlyEnrolled: number
  readonly now: string
  readonly createdAt: string
}

interface SubscriptionRenewalWrite {
  readonly id: string
  readonly expectedCredentialHash: string
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
  readonly userAgent: string
  readonly retryValidUntil: string
  readonly nextCredentialHash: string
  readonly now: string
}

export class SubscriptionsRepository extends Context.Service<SubscriptionsRepository, {
  readonly list: Effect.Effect<ReadonlyArray<PushSubscriptionRow>, RepositoryUnavailable>
  readonly listEnabled: Effect.Effect<ReadonlyArray<PushSubscriptionRow>, RepositoryUnavailable>
  readonly findById: (id: string) => Effect.Effect<PushSubscriptionRow | null, RepositoryUnavailable>
  readonly findByEndpoint: (endpoint: string) => Effect.Effect<PushSubscriptionRow | null, RepositoryUnavailable>
  readonly enroll: (values: SubscriptionEnrollmentWrite) => Effect.Effect<number, RepositoryUnavailable>
  readonly renew: (values: SubscriptionRenewalWrite) => Effect.Effect<number, RepositoryUnavailable>
  readonly update: (id: string, name: string, enabled: number | null, updatedAt: string) => Effect.Effect<number, RepositoryUnavailable>
  readonly remove: (id: string, removedAt: string) => Effect.Effect<void, RepositoryUnavailable>
}>()("ops-context/SubscriptionsRepository") {
  static readonly layer = Layer.effect(SubscriptionsRepository, Effect.gen(function*() {
    const db = yield* Database
    return SubscriptionsRepository.of({
      list: db.all(PushSubscriptionRowSchema, "SELECT * FROM push_subscriptions WHERE deleted_at IS NULL ORDER BY created_at DESC", [], "subscriptions.list"),
      listEnabled: db.all(PushSubscriptionRowSchema, "SELECT * FROM push_subscriptions WHERE enabled = 1 ORDER BY created_at", [], "subscriptions.list_enabled"),
      findById: (id) => db.first(PushSubscriptionRowSchema, "SELECT * FROM push_subscriptions WHERE id = ?", [id], "subscriptions.get_by_id"),
      findByEndpoint: (endpoint) => db.first(PushSubscriptionRowSchema, "SELECT * FROM push_subscriptions WHERE endpoint = ?", [endpoint], "subscriptions.get_by_endpoint"),
      enroll: (v) => db.run(`INSERT INTO push_subscriptions
        (id, name, endpoint, p256dh, auth, user_agent, enabled, last_seen_at,
         renewal_credential_hash, renewal_credential_issued_at, explicitly_enrolled,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          name = excluded.name, p256dh = excluded.p256dh, auth = excluded.auth,
          user_agent = excluded.user_agent, enabled = 1,
          last_seen_at = excluded.last_seen_at,
          renewal_credential_hash = excluded.renewal_credential_hash,
          renewal_credential_issued_at = excluded.renewal_credential_issued_at,
          previous_renewal_credential_hash = NULL,
          previous_renewal_credential_valid_until = NULL,
          explicitly_enrolled = MAX(push_subscriptions.explicitly_enrolled, excluded.explicitly_enrolled),
          enrollment_generation = CASE
            WHEN push_subscriptions.enabled = 0 AND excluded.explicitly_enrolled = 1
              THEN push_subscriptions.enrollment_generation + 1
            ELSE push_subscriptions.enrollment_generation
          END,
          deleted_at = NULL, updated_at = excluded.updated_at
        WHERE excluded.explicitly_enrolled = 1
           OR (push_subscriptions.enabled = 1 AND push_subscriptions.explicitly_enrolled = 0)`,
        [v.id, v.name, v.endpoint, v.p256dh, v.auth, v.userAgent, v.now,
          v.credentialHash, v.now, v.explicitlyEnrolled, v.createdAt, v.now],
        "subscriptions.enroll"
      ),
      renew: (v) => db.run(`UPDATE push_subscriptions
        SET endpoint = ?, p256dh = ?, auth = ?, user_agent = ?, last_seen_at = ?,
            previous_renewal_credential_hash = renewal_credential_hash,
            previous_renewal_credential_valid_until = ?,
            renewal_credential_hash = ?, renewal_credential_issued_at = ?, updated_at = ?
        WHERE id = ? AND enabled = 1 AND renewal_credential_hash = ?`,
        [v.endpoint, v.p256dh, v.auth, v.userAgent, v.now, v.retryValidUntil,
          v.nextCredentialHash, v.now, v.now, v.id, v.expectedCredentialHash],
        "subscriptions.renew"
      ),
      update: (id, name, enabled, updatedAt) => db.run(`UPDATE push_subscriptions
        SET name = ?, enabled = CASE WHEN ? IS NULL THEN enabled ELSE ? END,
            renewal_credential_hash = CASE WHEN ? = 0 THEN NULL ELSE renewal_credential_hash END,
            renewal_credential_issued_at = CASE WHEN ? = 0 THEN NULL ELSE renewal_credential_issued_at END,
            previous_renewal_credential_hash = CASE WHEN ? = 0 THEN NULL ELSE previous_renewal_credential_hash END,
            previous_renewal_credential_valid_until = CASE WHEN ? = 0 THEN NULL ELSE previous_renewal_credential_valid_until END,
            updated_at = ?
        WHERE id = ? AND (COALESCE(?, -1) <> 1 OR enabled = 1)`,
        [name, enabled, enabled, enabled, enabled, enabled, enabled, updatedAt, id, enabled],
        "subscriptions.update"
      ),
      remove: (id, removedAt) => db.batch([
        {
          sql: `UPDATE push_subscriptions SET enabled = 0,
            renewal_credential_hash = NULL, renewal_credential_issued_at = NULL,
            previous_renewal_credential_hash = NULL,
            previous_renewal_credential_valid_until = NULL,
            deleted_at = ?, updated_at = ? WHERE id = ?`,
          params: [removedAt, removedAt, id]
        },
        {
          sql: `DELETE FROM push_jobs
                WHERE subscription_id = ? AND state NOT IN ('sent', 'dead')`,
          params: [id]
        }
      ], "subscriptions.remove")
    })
  }))
}

export class SilencesRepository extends Context.Service<SilencesRepository, {
  readonly list: Effect.Effect<ReadonlyArray<SilenceRow>, RepositoryUnavailable>
  readonly findById: (id: string) => Effect.Effect<SilenceRow | null, RepositoryUnavailable>
  readonly insert: (values: { readonly id: string; readonly projectId: string | null; readonly field: SilenceField; readonly value: string; readonly note: string; readonly createdAt: string }) => Effect.Effect<void, RepositoryUnavailable>
  readonly delete: (id: string) => Effect.Effect<void, RepositoryUnavailable>
  readonly findMatch: (projectId: string, candidates: ReadonlyArray<readonly [SilenceField, string]>) => Effect.Effect<string | null, RepositoryUnavailable>
  readonly countSilencedEvents: Effect.Effect<number, RepositoryUnavailable>
}>()("ops-context/SilencesRepository") {
  static readonly layer = Layer.effect(SilencesRepository, Effect.gen(function*() {
    const db = yield* Database
    const Id = Schema.Struct({ id: Schema.String })
    const Count = Schema.Struct({ count: Schema.Number })
    const select = `SELECT s.id, s.project_id, p.name AS project_name, s.field, s.value, s.note, s.created_at
      FROM silences s LEFT JOIN projects p ON p.id = s.project_id`
    return SilencesRepository.of({
      list: db.all(SilenceRowSchema, `${select} ORDER BY s.created_at DESC`, [], "silences.list"),
      findById: (id) => db.first(SilenceRowSchema, `${select} WHERE s.id = ?`, [id], "silences.get_by_id"),
      insert: (v) => db.run(
        "INSERT INTO silences (id, project_id, field, value, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [v.id, v.projectId, v.field, v.value, v.note, v.createdAt], "silences.create"
      ).pipe(Effect.asVoid),
      delete: (id) => db.run("DELETE FROM silences WHERE id = ?", [id], "silences.delete").pipe(Effect.asVoid),
      findMatch: (projectId, candidates) => {
        const nonEmpty = candidates.filter((candidate) => candidate[1] !== "")
        if (nonEmpty.length === 0) return Effect.succeed(null)
        const params: Array<string | number> = []
        const candidateRows = nonEmpty.map(([field, value], priority) => {
          params.push(field, value, priority)
          return "(?, ?, ?)"
        })
        params.push(projectId, projectId)
        return db.all(Id, `WITH candidates(field, value, priority) AS (
          VALUES ${candidateRows.join(", ")}
        ) SELECT s.id FROM candidates c
          JOIN silences s ON s.field = c.field AND s.value = c.value
          WHERE s.project_id IS NULL OR s.project_id = ?
          ORDER BY c.priority, CASE WHEN s.project_id = ? THEN 0 ELSE 1 END
          LIMIT 1`, params, "silences.match"
        ).pipe(Effect.map((rows) => rows[0]?.id ?? null))
      },
      countSilencedEvents: db.first(Count, "SELECT COUNT(*) AS count FROM events WHERE silence_id IS NOT NULL", [], "silences.count_events")
        .pipe(Effect.map((row) => row?.count ?? 0))
    })
  }))
}

export interface StoredSettings {
  readonly retentionDays: string | null
  readonly redactKeys: ReadonlyArray<string>
  readonly setupCompleted: string | null
  readonly mcpEnabled: string | null
}

const decodeStoredRedactKeys = (
  raw: string | undefined
): Effect.Effect<ReadonlyArray<string>, RepositoryUnavailable> => {
  if (raw === undefined) return Effect.succeed([])
  try {
    const decoded: unknown = JSON.parse(raw)
    return Schema.decodeUnknownEffect(Schema.Array(Schema.String))(decoded).pipe(
      Effect.mapError(() => repositoryUnavailable("repository decode failed"))
    )
  } catch {
    return Effect.succeed(raw.split(",").map((key) => key.trim()).filter(Boolean))
  }
}

export class SettingsRepository extends Context.Service<SettingsRepository, {
  readonly get: Effect.Effect<StoredSettings, RepositoryUnavailable>
  readonly set: (key: "retention_days" | "redact_keys" | "setup_completed" | "mcp_enabled", value: string, updatedAt: string) => Effect.Effect<void, RepositoryUnavailable>
}>()("ops-context/SettingsRepository") {
  static readonly layer = Layer.effect(SettingsRepository, Effect.gen(function*() {
    const db = yield* Database
    const Row = Schema.Struct({ key: Schema.String, value: Schema.String })
    const get = db.all(Row, `SELECT key, value FROM settings
      WHERE key IN ('retention_days', 'redact_keys', 'setup_completed', 'mcp_enabled')`, [], "settings.load").pipe(
      Effect.flatMap((rows) => {
        const values = new Map(rows.map((row) => [row.key, row.value]))
        return decodeStoredRedactKeys(values.get("redact_keys")).pipe(Effect.map((redactKeys) => ({
          retentionDays: values.get("retention_days") ?? null,
          redactKeys,
          setupCompleted: values.get("setup_completed") ?? null,
          mcpEnabled: values.get("mcp_enabled") ?? null
        })))
      })
    )
    return SettingsRepository.of({
      get,
      set: (key, value, updatedAt) => db.run(`INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, updatedAt], "settings.set"
      ).pipe(Effect.asVoid)
    })
  }))
}

export class DeliveriesRepository extends Context.Service<DeliveriesRepository, {
  readonly listForEvent: (eventId: string) => Effect.Effect<ReadonlyArray<DeliveryRow>, RepositoryUnavailable>
  readonly latest: Effect.Effect<DeliveryRow | null, RepositoryUnavailable>
  readonly pruneSuccessfulBeforeEvent: (cutoff: string, limit: number) => Effect.Effect<number, RepositoryUnavailable>
}>()("ops-context/DeliveriesRepository") {
  static readonly layer = Layer.effect(DeliveriesRepository, Effect.gen(function*() {
    const db = yield* Database
    const select = `SELECT CAST(d.id AS TEXT) AS id, d.event_id, d.subscription_id,
      COALESCE(s.name, '') AS subscription_name, d.status, d.response_status, d.error, d.attempted_at
      FROM deliveries d LEFT JOIN push_subscriptions s ON s.id = d.subscription_id`
    return DeliveriesRepository.of({
      listForEvent: (eventId) => db.all(DeliveryRowSchema, `${select} WHERE d.event_id = ? ORDER BY d.attempted_at_ms DESC`, [eventId], "deliveries.list_for_event"),
      latest: db.first(DeliveryRowSchema, `${select} ORDER BY d.id DESC LIMIT 1`, [], "deliveries.latest"),
      pruneSuccessfulBeforeEvent: (cutoff, limit) => db.runCounted(
        pruneSuccessfulDeliveriesBeforeEventSql,
        [epochMs(cutoff), limit],
        "deliveries.prune_successful"
      )
    })
  }))
}

export interface SystemCounts {
  readonly projects: number
  readonly events: number
  readonly subscriptions: number
  readonly enabled_subscriptions: number
  readonly dead_jobs: number
  readonly failed_ingests: number
}

export class SystemRepository extends Context.Service<SystemRepository, {
  readonly health: Effect.Effect<void, RepositoryUnavailable>
  readonly counts: Effect.Effect<SystemCounts, RepositoryUnavailable>
}>()("ops-context/SystemRepository") {
  static readonly layer = Layer.effect(SystemRepository, Effect.gen(function*() {
    const db = yield* Database
    const Health = Schema.Struct({ ok: Schema.Number })
    const Counts = Schema.Struct({
      projects: Schema.Number, events: Schema.Number, subscriptions: Schema.Number,
      enabled_subscriptions: Schema.Number, dead_jobs: Schema.Number, failed_ingests: Schema.Number
    })
    return SystemRepository.of({
      health: db.first(Health, "SELECT 1 AS ok", [], "system.health").pipe(Effect.asVoid),
      counts: db.first(Counts, `SELECT
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM push_subscriptions WHERE deleted_at IS NULL) AS subscriptions,
        (SELECT COUNT(*) FROM push_subscriptions WHERE enabled = 1 AND deleted_at IS NULL) AS enabled_subscriptions,
        (SELECT COUNT(*) FROM push_jobs WHERE state = 'dead') AS dead_jobs,
        (SELECT COUNT(*) FROM ingestion_failures) AS failed_ingests`, [], "system.counts"
      ).pipe(Effect.map((row) => row ?? { projects: 0, events: 0, subscriptions: 0, enabled_subscriptions: 0, dead_jobs: 0, failed_ingests: 0 }))
    })
  }))
}

const RepositoryLayers = Layer.mergeAll(
  ProjectsRepository.layer,
  EventsRepository.layer,
  SubscriptionsRepository.layer,
  SilencesRepository.layer,
  SettingsRepository.layer,
  DeliveriesRepository.layer,
  SystemRepository.layer
)

export const D1RepositoriesLive = (db: D1Database) =>
  RepositoryLayers.pipe(Layer.provide(Database.layer(db)))
