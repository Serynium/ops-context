import { Effect } from "effect"
import { internal, type AppError } from "./errors.js"
import { newId, nowIso } from "./ids.js"
import { CredentialCrypto, Database, WebPush } from "./services.js"
import type { EventRow, PushJobMessage, PushSubscriptionRow } from "./types.js"

interface PushJobRow {
  readonly event_id: string
  readonly subscription_id: string
  readonly state: "pending" | "queued" | "sending" | "sent" | "failed"
  readonly attempts: number
  readonly available_at: string
  readonly queued_at: string | null
  readonly lease_until: string | null
  readonly last_error: string
  readonly updated_at: string
}

export type PushOutcome =
  | { readonly _tag: "Delivered" }
  | { readonly _tag: "PermanentFailure" }
  | { readonly _tag: "AlreadyProcessed" }
  | { readonly _tag: "Retry"; readonly delaySeconds: number }

const topicFor = (eventId: string): string =>
  eventId.replace(/[^A-Za-z0-9_-]/gu, "").slice(-32)

const responseBody = async (response: Response): Promise<string> =>
  (await response.text()).slice(0, 2_000)

const recordAttempt = (
  message: PushJobMessage,
  status: "sent" | "failed" | "skipped",
  responseStatus: number | null,
  error: string
): Effect.Effect<void, AppError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    const at = nowIso()
    const deliveryId = yield* newId("dlv")
    yield* db.run(
      `INSERT INTO deliveries
       (id, event_id, subscription_id, status, response_status, error, attempted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [deliveryId, message.eventId, message.subscriptionId, status, responseStatus, error.slice(0, 4_000), at, at]
    )
  })

const finalizeSuccess = (
  message: PushJobMessage,
  responseStatus: number
): Effect.Effect<void, AppError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* db.run(
      `UPDATE push_jobs
       SET state = 'sent', lease_until = NULL, last_error = '', updated_at = ?
       WHERE event_id = ? AND subscription_id = ?`,
      [nowIso(), message.eventId, message.subscriptionId]
    )
    yield* recordAttempt(message, "sent", responseStatus, "")
  })

const finalizePermanentFailure = (
  message: PushJobMessage,
  responseStatus: number | null,
  error: string,
  disableSubscription: boolean
): Effect.Effect<void, AppError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    const now = nowIso()
    const deliveryId = yield* newId("dlv")
    const statements = [
      {
        sql: `UPDATE push_jobs
              SET state = 'failed', lease_until = NULL, last_error = ?, updated_at = ?
              WHERE event_id = ? AND subscription_id = ?`,
        params: [error.slice(0, 4_000), now, message.eventId, message.subscriptionId]
      },
      {
        sql: `INSERT INTO deliveries
              (id, event_id, subscription_id, status, response_status, error, attempted_at, created_at)
              VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)`,
        params: [
          deliveryId,
          message.eventId,
          message.subscriptionId,
          responseStatus,
          error.slice(0, 4_000),
          now,
          now
        ]
      }
    ]
    if (disableSubscription) {
      statements.push({
        sql: "UPDATE push_subscriptions SET enabled = 0, updated_at = ? WHERE id = ?",
        params: [now, message.subscriptionId]
      })
    }
    yield* db.batch(statements)
  })

const scheduleRetry = (
  message: PushJobMessage,
  attempts: number,
  responseStatus: number | null,
  error: string
): Effect.Effect<number, AppError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    const delaySeconds = Math.min(900, Math.max(15, 15 * 2 ** Math.min(attempts, 6)))
    const availableAt = new Date(Date.now() + delaySeconds * 1_000).toISOString()
    const now = nowIso()
    const deliveryId = yield* newId("dlv")
    yield* db.batch([
      {
        sql: `UPDATE push_jobs
              SET state = 'pending', available_at = ?, queued_at = NULL, lease_until = NULL,
                  last_error = ?, updated_at = ?
              WHERE event_id = ? AND subscription_id = ?`,
        params: [availableAt, error.slice(0, 4_000), now, message.eventId, message.subscriptionId]
      },
      {
        sql: `INSERT INTO deliveries
              (id, event_id, subscription_id, status, response_status, error, attempted_at, created_at)
              VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)`,
        params: [
          deliveryId,
          message.eventId,
          message.subscriptionId,
          responseStatus,
          error.slice(0, 4_000),
          now,
          now
        ]
      }
    ])
    return delaySeconds
  })

interface PushContext {
  readonly job: PushJobRow
  readonly event: EventRow
  readonly subscription: PushSubscriptionRow
}

const loadContext = (
  message: PushJobMessage
): Effect.Effect<PushContext | null, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const job = yield* db.first<PushJobRow>(
      "SELECT * FROM push_jobs WHERE event_id = ? AND subscription_id = ?",
      [message.eventId, message.subscriptionId]
    )
    if (!job) return null

    const event = yield* db.first<EventRow>(
      `SELECT
         e.id, e.external_id, e.project_id,
         p.name AS project_name, p.slug AS project_slug, p.icon AS project_icon,
         e.source, e.type, e.level, e.title, e.body, e.fingerprint,
         e.payload_json, e.occurred_at, e.created_at, e.silence_id
       FROM events e
       JOIN projects p ON p.id = e.project_id
       WHERE e.id = ?`,
      [message.eventId]
    )
    const subscription = yield* db.first<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE id = ?",
      [message.subscriptionId]
    )
    if (!event || !subscription) return null
    return { job, event, subscription }
  })

const claim = (message: PushJobMessage): Effect.Effect<boolean, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const now = nowIso()
    const leaseUntil = new Date(Date.now() + 60_000).toISOString()
    const result = yield* db.run(
      `UPDATE push_jobs
       SET state = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
       WHERE event_id = ? AND subscription_id = ?
         AND (
           state IN ('pending', 'queued')
           OR (state = 'sending' AND (lease_until IS NULL OR lease_until < ?))
         )
         AND available_at <= ?`,
      [leaseUntil, now, message.eventId, message.subscriptionId, now, now]
    )
    return ((result.meta as { readonly changes?: number }).changes ?? 0) > 0
  })

export const processPushMessage = (
  message: PushJobMessage
): Effect.Effect<PushOutcome, AppError, Database | WebPush | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    const webPush = yield* WebPush

    const before = yield* db.first<PushJobRow>(
      "SELECT * FROM push_jobs WHERE event_id = ? AND subscription_id = ?",
      [message.eventId, message.subscriptionId]
    )
    if (!before || before.state === "sent" || before.state === "failed") {
      return { _tag: "AlreadyProcessed" } as const
    }

    if (!(yield* claim(message))) return { _tag: "AlreadyProcessed" } as const
    const context = yield* loadContext(message)
    if (!context) {
      yield* finalizePermanentFailure(message, null, "event or subscription no longer exists", false)
      return { _tag: "PermanentFailure" } as const
    }
    if (context.subscription.enabled !== 1) {
      yield* finalizePermanentFailure(message, null, "push subscription is disabled", false)
      return { _tag: "PermanentFailure" } as const
    }

    const title = context.event.body
      ? `${context.event.project_name} · ${context.event.title}`
      : context.event.project_name
    const body = context.event.body || context.event.title
    const urgency = context.event.level === "critical" || context.event.level === "error" ? "high" : "normal"

    const sent = yield* webPush.send(
      {
        endpoint: context.subscription.endpoint,
        keys: {
          p256dh: context.subscription.p256dh,
          auth: context.subscription.auth
        }
      },
      {
        payload: {
          title,
          body,
          icon: "/icons/icon-192.png",
          badge: "/icons/badge-96.png",
          tag: context.event.id,
          data: {
            url: `/?event=${encodeURIComponent(context.event.id)}`,
            eventId: context.event.id,
            projectId: context.event.project_id,
            level: context.event.level
          }
        },
        options: {
          ttl: 86_400,
          urgency,
          topic: topicFor(context.event.id)
        }
      }
    ).pipe(
      Effect.catch((error) =>
        scheduleRetry(message, context.job.attempts, null, error.message).pipe(
          Effect.map((delaySeconds) => ({ _tag: "Retry", delaySeconds } as PushOutcome))
        )
      )
    )

    if (!(sent instanceof Response)) return sent

    if (sent.ok) {
      yield* finalizeSuccess(message, sent.status)
      return { _tag: "Delivered" } as const
    }

    const details = (yield* Effect.tryPromise({
      try: () => responseBody(sent),
      catch: (cause) => internal("failed to read Web Push response", cause)
    })) || `push service returned HTTP ${sent.status}`
    if (sent.status === 404 || sent.status === 410) {
      yield* finalizePermanentFailure(message, sent.status, details, true)
      return { _tag: "PermanentFailure" } as const
    }

    if (sent.status === 408 || sent.status === 425 || sent.status === 429 || sent.status >= 500) {
      const delaySeconds = yield* scheduleRetry(message, context.job.attempts, sent.status, details)
      return { _tag: "Retry", delaySeconds } as const
    }

    yield* finalizePermanentFailure(message, sent.status, details, false)
    return { _tag: "PermanentFailure" } as const
  }).pipe(Effect.withSpan("PushDelivery.process", { attributes: { eventId: message.eventId } }))
