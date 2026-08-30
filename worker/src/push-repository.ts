import { Context, Effect, Layer, Schema } from "effect"
import type {
  CryptographyUnavailable,
  RepositoryUnavailable
} from "./errors.js"
import { repositoryUnavailable } from "./errors.js"
import { nowIso } from "./ids.js"
import type { DeliverPushCommand } from "./queue-contract.js"
import { CredentialCrypto, Database, type SqlStatement } from "./services.js"
import type { EventRow, PushSubscriptionRow } from "./types.js"

export type PushJobState =
  | "pending"
  | "queued"
  | "sending"
  | "retrying"
  | "sent"
  | "dead"

export interface PushJobRow {
  readonly event_id: string
  readonly subscription_id: string
  readonly state: PushJobState
  readonly attempts: number
  readonly available_at: string
  readonly queued_at: string | null
  readonly lease_until: string | null
  readonly dead_at: string | null
  readonly last_error: string
  readonly updated_at: string
}

export interface ClaimedPushJob {
  readonly message: DeliverPushCommand
  readonly leaseUntil: string
}

export interface DeferredPushJob {
  readonly availableAt: string
}

export interface PushContext {
  readonly job: PushJobRow
  readonly event: EventRow
  readonly subscription: PushSubscriptionRow
}

interface PushContextRow {
  readonly job_event_id: string
  readonly job_subscription_id: string
  readonly job_state: PushJobState
  readonly job_attempts: number
  readonly job_available_at: string
  readonly job_queued_at: string | null
  readonly job_lease_until: string | null
  readonly job_dead_at: string | null
  readonly job_last_error: string
  readonly job_updated_at: string
  readonly event_external_id: string | null
  readonly event_project_id: string
  readonly project_name: string
  readonly project_slug: string
  readonly project_icon: string
  readonly event_source: string
  readonly event_type: string
  readonly event_level: EventRow["level"]
  readonly event_title: string
  readonly event_body: string
  readonly event_fingerprint: string
  readonly event_payload_json: string
  readonly event_actions_json: string
  readonly event_occurred_at: string
  readonly event_created_at: string
  readonly event_silence_id: string | null
  readonly subscription_name: string
  readonly subscription_endpoint: string
  readonly subscription_p256dh: string
  readonly subscription_auth: string
  readonly subscription_user_agent: string
  readonly subscription_enabled: number
  readonly subscription_last_seen_at: string | null
  readonly subscription_renewal_credential_hash: string | null
  readonly subscription_renewal_credential_issued_at: string | null
  readonly subscription_previous_renewal_credential_hash: string | null
  readonly subscription_previous_renewal_credential_valid_until: string | null
  readonly subscription_explicitly_enrolled: number
  readonly subscription_deleted_at: string | null
  readonly subscription_created_at: string
  readonly subscription_updated_at: string
}

const PushJobStateSchema = Schema.Literals(["pending", "queued", "sending", "retrying", "sent", "dead"])
const nullableString = Schema.NullOr(Schema.String)
const storedJson = (validate: (value: unknown) => boolean) => Schema.String.pipe(
  Schema.refine((value): value is string => {
    try {
      return validate(JSON.parse(value) as unknown)
    } catch {
      return false
    }
  }, { message: "stored JSON is invalid" })
)
const PushContextRowSchema = Schema.Struct({
  job_event_id: Schema.String,
  job_subscription_id: Schema.String,
  job_state: PushJobStateSchema,
  job_attempts: Schema.Number,
  job_available_at: Schema.String,
  job_queued_at: nullableString,
  job_lease_until: nullableString,
  job_dead_at: nullableString,
  job_last_error: Schema.String,
  job_updated_at: Schema.String,
  event_external_id: nullableString,
  event_project_id: Schema.String,
  project_name: Schema.String,
  project_slug: Schema.String,
  project_icon: Schema.String,
  event_source: Schema.String,
  event_type: Schema.String,
  event_level: Schema.Literals(["info", "success", "warning", "error", "critical"]),
  event_title: Schema.String,
  event_body: Schema.String,
  event_fingerprint: Schema.String,
  event_payload_json: storedJson((value) => typeof value === "object" && value !== null && !Array.isArray(value)),
  event_actions_json: storedJson((value) => Array.isArray(value) && value.length <= 3 && value.every((entry) =>
    typeof entry === "object" && entry !== null &&
    typeof (entry as { readonly label?: unknown }).label === "string" &&
    typeof (entry as { readonly url?: unknown }).url === "string"
  )),
  event_occurred_at: Schema.String,
  event_created_at: Schema.String,
  event_silence_id: nullableString,
  subscription_name: Schema.String,
  subscription_endpoint: Schema.String,
  subscription_p256dh: Schema.String,
  subscription_auth: Schema.String,
  subscription_user_agent: Schema.String,
  subscription_enabled: Schema.Number,
  subscription_last_seen_at: nullableString,
  subscription_renewal_credential_hash: nullableString,
  subscription_renewal_credential_issued_at: nullableString,
  subscription_previous_renewal_credential_hash: nullableString,
  subscription_previous_renewal_credential_valid_until: nullableString,
  subscription_explicitly_enrolled: Schema.Number,
  subscription_deleted_at: nullableString,
  subscription_created_at: Schema.String,
  subscription_updated_at: Schema.String
})
const DeferredPushJobSchema = Schema.Struct({ state: PushJobStateSchema, available_at: Schema.String })
const PushJobStateRowSchema = Schema.Struct({ state: PushJobStateSchema })

const decodeRow = <A>(schema: Schema.Schema<A>, row: unknown): Effect.Effect<A, RepositoryUnavailable> =>
  Schema.decodeUnknownEffect(schema)(row).pipe(
    Effect.mapError(() => repositoryUnavailable("repository read failed"))
  ) as Effect.Effect<A, RepositoryUnavailable>

const deliveryInsert = (
  id: string,
  claim: ClaimedPushJob,
  status: "sent" | "failed",
  responseStatus: number | null,
  error: string,
  attemptedAt: string
): SqlStatement => ({
  name: "deliveries.create",
  sql: `INSERT INTO deliveries
        (id, event_id, subscription_id, status, response_status, error, attempted_at, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM push_jobs
          WHERE event_id = ? AND subscription_id = ?
            AND state = 'sending' AND lease_until = ?
        )`,
  params: [
    id,
    claim.message.eventId,
    claim.message.subscriptionId,
    status,
    responseStatus,
    error.slice(0, 4_000),
    attemptedAt,
    attemptedAt,
    claim.message.eventId,
    claim.message.subscriptionId,
    claim.leaseUntil
  ]
})

const mapContext = (row: PushContextRow): PushContext => ({
  job: {
    event_id: row.job_event_id,
    subscription_id: row.job_subscription_id,
    state: row.job_state,
    attempts: row.job_attempts,
    available_at: row.job_available_at,
    queued_at: row.job_queued_at,
    lease_until: row.job_lease_until,
    dead_at: row.job_dead_at,
    last_error: row.job_last_error,
    updated_at: row.job_updated_at
  },
  event: {
    id: row.job_event_id,
    external_id: row.event_external_id,
    project_id: row.event_project_id,
    project_name: row.project_name,
    project_slug: row.project_slug,
    project_icon: row.project_icon,
    source: row.event_source,
    type: row.event_type,
    level: row.event_level,
    title: row.event_title,
    body: row.event_body,
    fingerprint: row.event_fingerprint,
    payload_json: row.event_payload_json,
    actions_json: row.event_actions_json,
    occurred_at: row.event_occurred_at,
    created_at: row.event_created_at,
    silence_id: row.event_silence_id
  },
  subscription: {
    id: row.job_subscription_id,
    name: row.subscription_name,
    endpoint: row.subscription_endpoint,
    p256dh: row.subscription_p256dh,
    auth: row.subscription_auth,
    user_agent: row.subscription_user_agent,
    enabled: row.subscription_enabled,
    last_seen_at: row.subscription_last_seen_at,
    renewal_credential_hash: row.subscription_renewal_credential_hash,
    renewal_credential_issued_at: row.subscription_renewal_credential_issued_at,
    previous_renewal_credential_hash: row.subscription_previous_renewal_credential_hash,
    previous_renewal_credential_valid_until: row.subscription_previous_renewal_credential_valid_until,
    explicitly_enrolled: row.subscription_explicitly_enrolled,
    deleted_at: row.subscription_deleted_at,
    created_at: row.subscription_created_at,
    updated_at: row.subscription_updated_at
  }
})

export interface PushDeliveryRepositoryService {
  readonly claim: (
    message: DeliverPushCommand
  ) => Effect.Effect<ClaimedPushJob | DeferredPushJob | null, RepositoryUnavailable>
  readonly loadClaimedContext: (
    claim: ClaimedPushJob
  ) => Effect.Effect<PushContext | null, RepositoryUnavailable>
  readonly finalizeSuccess: (
    claim: ClaimedPushJob,
    responseStatus: number
  ) => Effect.Effect<void, RepositoryUnavailable | CryptographyUnavailable>
  readonly finalizeRetry: (
    claim: ClaimedPushJob,
    responseStatus: number | null,
    error: string,
    availableAt: string
  ) => Effect.Effect<void, RepositoryUnavailable | CryptographyUnavailable>
  readonly finalizeDead: (
    claim: ClaimedPushJob,
    responseStatus: number | null,
    error: string,
    revokedEndpoint: string | null
  ) => Effect.Effect<void, RepositoryUnavailable | CryptographyUnavailable>
  readonly finalizeDeadLetter: (
    message: DeliverPushCommand,
    reason: string
  ) => Effect.Effect<boolean, RepositoryUnavailable | CryptographyUnavailable>
}

export type PushDeliveryRepositoryError = RepositoryUnavailable | CryptographyUnavailable

export class PushDeliveryRepository extends Context.Service<
  PushDeliveryRepository,
  PushDeliveryRepositoryService
>()("ops-context/PushDeliveryRepository") {
  static readonly layer = Layer.effect(
    PushDeliveryRepository,
    Effect.gen(function*() {
      const db = yield* Database
      const crypto = yield* CredentialCrypto

      const claim: PushDeliveryRepositoryService["claim"] = (message) =>
        Effect.gen(function*() {
          const now = nowIso()
          const leaseUntil = new Date(Date.now() + 60_000).toISOString()
          const result = yield* db.run(
            "push_jobs.claim",
            `UPDATE push_jobs
             SET state = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
             WHERE event_id = ? AND subscription_id = ?
               AND (
                 state IN ('pending', 'queued', 'retrying')
                 OR (state = 'sending' AND (lease_until IS NULL OR lease_until < ?))
               )
               AND available_at <= ?`,
            [leaseUntil, now, message.eventId, message.subscriptionId, now, now]
          )
          const changed = ((result.meta as { readonly changes?: number }).changes ?? 0) > 0
          if (changed) return { message, leaseUntil }

          // A delayed Queue message should not normally arrive early, but acknowledging one
          // would orphan a retrying job because maintenance deliberately does not republish it.
          // Only the failed-claim path pays for this diagnostic read.
          const deferredRaw = yield* db.first<Record<string, unknown>>(
            "push_jobs.get_deferred",
            `SELECT state, available_at FROM push_jobs
             WHERE event_id = ? AND subscription_id = ?`,
            [message.eventId, message.subscriptionId]
          )
          const deferred = deferredRaw === null ? null : yield* decodeRow(DeferredPushJobSchema, deferredRaw)
          return deferred &&
              (deferred.state === "pending" ||
                deferred.state === "queued" ||
                deferred.state === "retrying") &&
              deferred.available_at > now
            ? { availableAt: deferred.available_at }
            : null
        })

      const loadClaimedContext: PushDeliveryRepositoryService["loadClaimedContext"] = (claimed) =>
        db.first<Record<string, unknown>>(
          "push_jobs.get_claimed_context",
          `SELECT
             j.event_id AS job_event_id,
             j.subscription_id AS job_subscription_id,
             j.state AS job_state,
             j.attempts AS job_attempts,
             j.available_at AS job_available_at,
             j.queued_at AS job_queued_at,
             j.lease_until AS job_lease_until,
             j.dead_at AS job_dead_at,
             j.last_error AS job_last_error,
             j.updated_at AS job_updated_at,
             e.external_id AS event_external_id,
             e.project_id AS event_project_id,
             p.name AS project_name,
             p.slug AS project_slug,
             p.icon AS project_icon,
             e.source AS event_source,
             e.type AS event_type,
             e.level AS event_level,
             e.title AS event_title,
             e.body AS event_body,
             e.fingerprint AS event_fingerprint,
             e.payload_json AS event_payload_json,
             e.actions_json AS event_actions_json,
             e.occurred_at AS event_occurred_at,
             e.created_at AS event_created_at,
             e.silence_id AS event_silence_id,
             s.name AS subscription_name,
             s.endpoint AS subscription_endpoint,
             s.p256dh AS subscription_p256dh,
             s.auth AS subscription_auth,
             s.user_agent AS subscription_user_agent,
             s.enabled AS subscription_enabled,
             s.last_seen_at AS subscription_last_seen_at,
             s.renewal_credential_hash AS subscription_renewal_credential_hash,
             s.renewal_credential_issued_at AS subscription_renewal_credential_issued_at,
             s.previous_renewal_credential_hash AS subscription_previous_renewal_credential_hash,
             s.previous_renewal_credential_valid_until AS subscription_previous_renewal_credential_valid_until,
             s.explicitly_enrolled AS subscription_explicitly_enrolled,
             s.deleted_at AS subscription_deleted_at,
             s.created_at AS subscription_created_at,
             s.updated_at AS subscription_updated_at
           FROM push_jobs j
           JOIN events e ON e.id = j.event_id
           JOIN projects p ON p.id = e.project_id
           JOIN push_subscriptions s ON s.id = j.subscription_id
           WHERE j.event_id = ? AND j.subscription_id = ?
             AND j.state = 'sending' AND j.lease_until = ?`,
          [claimed.message.eventId, claimed.message.subscriptionId, claimed.leaseUntil]
        ).pipe(Effect.flatMap((row) => row === null
          ? Effect.succeed(null)
          : decodeRow(PushContextRowSchema, row).pipe(Effect.map(mapContext))))

      const finalizeSuccess: PushDeliveryRepositoryService["finalizeSuccess"] = (
        claimed,
        responseStatus
      ) => Effect.gen(function*() {
        const now = nowIso()
        const deliveryId = yield* crypto.newId("dlv")
        yield* db.batch("push_jobs.finalize_success", [
          deliveryInsert(deliveryId, claimed, "sent", responseStatus, "", now),
          {
            name: "push_jobs.mark_sent",
            sql: `UPDATE push_jobs
                  SET state = 'sent', lease_until = NULL, dead_at = NULL,
                      last_error = '', updated_at = ?
                  WHERE event_id = ? AND subscription_id = ?
                    AND state = 'sending' AND lease_until = ?`,
            params: [
              now,
              claimed.message.eventId,
              claimed.message.subscriptionId,
              claimed.leaseUntil
            ]
          }
        ])
      })

      const finalizeRetry: PushDeliveryRepositoryService["finalizeRetry"] = (
        claimed,
        responseStatus,
        error,
        availableAt
      ) => Effect.gen(function*() {
        const now = nowIso()
        const deliveryId = yield* crypto.newId("dlv")
        yield* db.batch("push_jobs.finalize_retry", [
          deliveryInsert(deliveryId, claimed, "failed", responseStatus, error, now),
          {
            name: "push_jobs.mark_retrying",
            sql: `UPDATE push_jobs
                  SET state = 'retrying', available_at = ?, queued_at = ?,
                      lease_until = NULL, dead_at = NULL, last_error = ?, updated_at = ?
                  WHERE event_id = ? AND subscription_id = ?
                    AND state = 'sending' AND lease_until = ?`,
            params: [
              availableAt,
              now,
              error.slice(0, 4_000),
              now,
              claimed.message.eventId,
              claimed.message.subscriptionId,
              claimed.leaseUntil
            ]
          }
        ])
      })

      const finalizeDead: PushDeliveryRepositoryService["finalizeDead"] = (
        claimed,
        responseStatus,
        error,
        revokedEndpoint
      ) => Effect.gen(function*() {
        const now = nowIso()
        const deliveryId = yield* crypto.newId("dlv")
        const statements: Array<SqlStatement> = [
          deliveryInsert(deliveryId, claimed, "failed", responseStatus, error, now)
        ]
        if (revokedEndpoint !== null) {
          statements.push({
            name: "subscriptions.disable",
            sql: `UPDATE push_subscriptions
                  SET enabled = 0,
                      renewal_credential_hash = NULL,
                      renewal_credential_issued_at = NULL,
                      previous_renewal_credential_hash = NULL,
                      previous_renewal_credential_valid_until = NULL,
                      updated_at = ?
                  WHERE id = ? AND endpoint = ? AND EXISTS (
                    SELECT 1 FROM push_jobs
                    WHERE event_id = ? AND subscription_id = ?
                      AND state = 'sending' AND lease_until = ?
                  )`,
            params: [
              now,
              claimed.message.subscriptionId,
              revokedEndpoint,
              claimed.message.eventId,
              claimed.message.subscriptionId,
              claimed.leaseUntil
            ]
          })
        }
        statements.push({
          name: "push_jobs.mark_dead",
          sql: `UPDATE push_jobs
                SET state = 'dead', lease_until = NULL, dead_at = ?,
                    last_error = ?, updated_at = ?
                WHERE event_id = ? AND subscription_id = ?
                  AND state = 'sending' AND lease_until = ?`,
          params: [
            now,
            error.slice(0, 4_000),
            now,
            claimed.message.eventId,
            claimed.message.subscriptionId,
            claimed.leaseUntil
          ]
        })
        yield* db.batch("push_jobs.finalize_dead", statements)
      })

      const finalizeDeadLetter: PushDeliveryRepositoryService["finalizeDeadLetter"] = (
        message,
        reason
      ) => Effect.gen(function*() {
        const existingRaw = yield* db.first<Record<string, unknown>>(
          "push_jobs.get_for_dead_letter",
          `SELECT state FROM push_jobs
           WHERE event_id = ? AND subscription_id = ?`,
          [message.eventId, message.subscriptionId]
        )
        const existing = existingRaw === null ? null : yield* decodeRow(PushJobStateRowSchema, existingRaw)
        if (!existing || existing.state === "sent" || existing.state === "dead") return false

        const now = nowIso()
        const deliveryId = yield* crypto.newId("dlv")
        yield* db.batch("push_jobs.finalize_dead_letter", [
          {
            name: "deliveries.create",
            sql: `INSERT INTO deliveries
                  (id, event_id, subscription_id, status, response_status, error,
                   attempted_at, created_at)
                  SELECT ?, ?, ?, 'failed', NULL, ?, ?, ?
                  WHERE EXISTS (
                    SELECT 1 FROM push_jobs
                    WHERE event_id = ? AND subscription_id = ?
                      AND state NOT IN ('sent', 'dead')
                  )`,
            params: [
              deliveryId,
              message.eventId,
              message.subscriptionId,
              reason.slice(0, 4_000),
              now,
              now,
              message.eventId,
              message.subscriptionId
            ]
          },
          {
            name: "push_jobs.mark_dead",
            sql: `UPDATE push_jobs
                  SET state = 'dead', lease_until = NULL, dead_at = ?,
                      last_error = ?, updated_at = ?
                  WHERE event_id = ? AND subscription_id = ?
                    AND state NOT IN ('sent', 'dead')`,
            params: [
              now,
              reason.slice(0, 4_000),
              now,
              message.eventId,
              message.subscriptionId
            ]
          }
        ])
        return true
      })

      return PushDeliveryRepository.of({
        claim,
        loadClaimedContext,
        finalizeSuccess,
        finalizeRetry,
        finalizeDead,
        finalizeDeadLetter
      })
    })
  )
}
