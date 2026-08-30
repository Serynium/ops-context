import { Effect } from "effect"
import { type AppError } from "./errors.js"
import { newId, nowIso } from "./ids.js"
import { AppConfig, CredentialCrypto, Database, WebPush } from "./services.js"
import type { EventAction, EventRow, PushJobMessage, PushSubscriptionRow } from "./types.js"

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

export type PushOutcome =
  | { readonly _tag: "Delivered" }
  | { readonly _tag: "PermanentFailure" }
  | { readonly _tag: "AlreadyProcessed" }
  | { readonly _tag: "Retry"; readonly delaySeconds: number }

const terminalStates = new Set<PushJobState>(["sent", "dead"])

const topicFor = (eventId: string): string =>
  eventId.replace(/[^A-Za-z0-9_-]/gu, "").slice(-32)

const responseBody = async (response: Response): Promise<string> =>
  (await response.text()).slice(0, 2_000)

const parseActions = (value: string): ReadonlyArray<EventAction> => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return []
      const label = (entry as { readonly label?: unknown }).label
      const url = (entry as { readonly url?: unknown }).url
      return typeof label === "string" && typeof url === "string" ? [{ label, url }] : []
    }).slice(0, 3)
  } catch {
    return []
  }
}

const deliveryInsert = (
  id: string,
  message: PushJobMessage,
  status: "sent" | "failed" | "skipped",
  responseStatus: number | null,
  error: string,
  attemptedAt: string
) => ({
  sql: `INSERT INTO deliveries
        (id, event_id, subscription_id, status, response_status, error, attempted_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  params: [
    id,
    message.eventId,
    message.subscriptionId,
    status,
    responseStatus,
    error.slice(0, 4_000),
    attemptedAt,
    attemptedAt
  ]
})

const finalizeSuccess = (
  message: PushJobMessage,
  responseStatus: number
): Effect.Effect<void, AppError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    const now = nowIso()
    const deliveryId = yield* newId("dlv")
    yield* db.batch([
      {
        sql: `UPDATE push_jobs
              SET state = 'sent', lease_until = NULL, dead_at = NULL,
                  last_error = '', updated_at = ?
              WHERE event_id = ? AND subscription_id = ?`,
        params: [now, message.eventId, message.subscriptionId]
      },
      deliveryInsert(deliveryId, message, "sent", responseStatus, "", now)
    ])
  })

const finalizeDead = (
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
              SET state = 'dead', lease_until = NULL, dead_at = ?,
                  last_error = ?, updated_at = ?
              WHERE event_id = ? AND subscription_id = ?`,
        params: [now, error.slice(0, 4_000), now, message.eventId, message.subscriptionId]
      },
      deliveryInsert(deliveryId, message, "failed", responseStatus, error, now)
    ]
    if (disableSubscription) {
      statements.push({
        sql: `UPDATE push_subscriptions
              SET enabled = 0, renewal_credential_hash = NULL,
                  renewal_credential_issued_at = NULL,
                  previous_renewal_credential_hash = NULL,
                  previous_renewal_credential_valid_until = NULL,
                  updated_at = ?
              WHERE id = ?`,
        params: [now, message.subscriptionId]
      })
    }
    yield* db.batch(statements)
  })

const retryDelaySeconds = (attempts: number): number =>
  Math.min(900, Math.max(15, 15 * 2 ** Math.min(attempts, 6)))

const retryOrDead = (
  message: PushJobMessage,
  attempts: number,
  responseStatus: number | null,
  error: string
): Effect.Effect<PushOutcome, AppError, Database | CredentialCrypto | AppConfig> =>
  Effect.gen(function*() {
    const db = yield* Database
    const config = yield* AppConfig

    if (attempts >= config.maxPushAttempts) {
      yield* finalizeDead(
        message,
        responseStatus,
        `delivery exhausted after ${attempts} attempts: ${error}`,
        false
      )
      return { _tag: "PermanentFailure" } as const
    }

    const delaySeconds = retryDelaySeconds(attempts)
    const availableAt = new Date(Date.now() + delaySeconds * 1_000).toISOString()
    const now = nowIso()
    const deliveryId = yield* newId("dlv")
    yield* db.batch([
      {
        sql: `UPDATE push_jobs
              SET state = 'retrying', available_at = ?, queued_at = ?,
                  lease_until = NULL, dead_at = NULL, last_error = ?, updated_at = ?
              WHERE event_id = ? AND subscription_id = ?`,
        params: [
          availableAt,
          now,
          error.slice(0, 4_000),
          now,
          message.eventId,
          message.subscriptionId
        ]
      },
      deliveryInsert(deliveryId, message, "failed", responseStatus, error, now)
    ])
    return { _tag: "Retry", delaySeconds } as const
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
         e.payload_json, e.actions_json, e.occurred_at, e.created_at, e.silence_id
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
           state IN ('pending', 'queued', 'retrying')
           OR (state = 'sending' AND (lease_until IS NULL OR lease_until < ?))
         )
         AND available_at <= ?`,
      [leaseUntil, now, message.eventId, message.subscriptionId, now, now]
    )
    return ((result.meta as { readonly changes?: number }).changes ?? 0) > 0
  })

const secondsUntil = (iso: string): number =>
  Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 1_000))

export const processPushMessage = (
  message: PushJobMessage
): Effect.Effect<PushOutcome, AppError, Database | WebPush | CredentialCrypto | AppConfig> =>
  Effect.gen(function*() {
    const db = yield* Database
    const webPush = yield* WebPush

    const before = yield* db.first<PushJobRow>(
      "SELECT * FROM push_jobs WHERE event_id = ? AND subscription_id = ?",
      [message.eventId, message.subscriptionId]
    )
    if (!before || terminalStates.has(before.state)) {
      return { _tag: "AlreadyProcessed" } as const
    }

    if (before.available_at > nowIso()) {
      return { _tag: "Retry", delaySeconds: secondsUntil(before.available_at) } as const
    }

    if (!(yield* claim(message))) return { _tag: "AlreadyProcessed" } as const
    const context = yield* loadContext(message)
    if (!context) {
      yield* finalizeDead(message, null, "event or subscription no longer exists", false)
      return { _tag: "PermanentFailure" } as const
    }
    if (context.subscription.enabled !== 1) {
      yield* finalizeDead(message, null, "push subscription is disabled", false)
      return { _tag: "PermanentFailure" } as const
    }

    const title = context.event.body
      ? `${context.event.project_name} · ${context.event.title}`
      : context.event.project_name
    const body = context.event.body || context.event.title
    const urgency = context.event.level === "critical" || context.event.level === "error" ? "high" : "normal"
    const eventActions = parseActions(context.event.actions_json)
    const notificationActions = eventActions.map((action, index) => ({
      action: `event-action-${index}`,
      title: action.label
    }))
    const actionUrls = Object.fromEntries(
      eventActions.map((action, index) => [`event-action-${index}`, action.url])
    )

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
          ...(notificationActions.length > 0 ? { actions: notificationActions } : {}),
          data: {
            url: `/?event=${encodeURIComponent(context.event.id)}`,
            eventId: context.event.id,
            projectId: context.event.project_id,
            level: context.event.level,
            actionUrls
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
        retryOrDead(message, context.job.attempts, null, error.message)
      )
    )

    if (!(sent instanceof Response)) return sent

    if (sent.ok) {
      yield* finalizeSuccess(message, sent.status)
      return { _tag: "Delivered" } as const
    }

    const details = yield* Effect.tryPromise({
      try: () => responseBody(sent),
      catch: () => `push service returned HTTP ${sent.status}`
    }).pipe(Effect.catch(() => Effect.succeed(`push service returned HTTP ${sent.status}`)))

    if (sent.status === 404 || sent.status === 410) {
      yield* finalizeDead(message, sent.status, details || `push service returned HTTP ${sent.status}`, true)
      return { _tag: "PermanentFailure" } as const
    }

    if (sent.status === 408 || sent.status === 425 || sent.status === 429 || sent.status >= 500) {
      return yield* retryOrDead(
        message,
        context.job.attempts,
        sent.status,
        details || `push service returned HTTP ${sent.status}`
      )
    }

    yield* finalizeDead(message, sent.status, details || `push service returned HTTP ${sent.status}`, false)
    return { _tag: "PermanentFailure" } as const
  }).pipe(Effect.withSpan("PushDelivery.process", { attributes: { eventId: message.eventId } }))

export const processDeadLetterMessage = (
  message: PushJobMessage,
  reason = "Cloudflare Queue moved the message to the dead-letter queue"
): Effect.Effect<PushOutcome, AppError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    const job = yield* db.first<PushJobRow>(
      "SELECT * FROM push_jobs WHERE event_id = ? AND subscription_id = ?",
      [message.eventId, message.subscriptionId]
    )
    if (!job || terminalStates.has(job.state)) {
      return { _tag: "AlreadyProcessed" } as const
    }
    yield* finalizeDead(message, null, reason, false)
    return { _tag: "PermanentFailure" } as const
  }).pipe(Effect.withSpan("PushDelivery.deadLetter", { attributes: { eventId: message.eventId } }))
