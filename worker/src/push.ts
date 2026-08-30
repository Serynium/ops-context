import { Effect } from "effect"
import {
  type ClaimedPushJob,
  PushDeliveryRepository,
  type PushDeliveryRepositoryError
} from "./push-repository.js"
import type { DeliverPushCommand } from "./queue-contract.js"
import { AppConfig, WebPush } from "./services.js"
import type { EventAction } from "./types.js"

export type { PushJobRow, PushJobState } from "./push-repository.js"

export type PushOutcome =
  | { readonly _tag: "Delivered" }
  | { readonly _tag: "PermanentFailure" }
  | { readonly _tag: "AlreadyProcessed" }
  | { readonly _tag: "Retry"; readonly delaySeconds: number }

export type PushDeliveryError = PushDeliveryRepositoryError

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

const finalizeSuccess = (
  claim: ClaimedPushJob,
  responseStatus: number
): Effect.Effect<void, PushDeliveryError, PushDeliveryRepository> =>
  Effect.gen(function*() {
    const repository = yield* PushDeliveryRepository
    yield* repository.finalizeSuccess(claim, responseStatus)
  })

const finalizeDead = (
  claim: ClaimedPushJob,
  responseStatus: number | null,
  error: string,
  disableSubscription: boolean
): Effect.Effect<void, PushDeliveryError, PushDeliveryRepository> =>
  Effect.gen(function*() {
    const repository = yield* PushDeliveryRepository
    yield* repository.finalizeDead(claim, responseStatus, error, disableSubscription)
  })

const retryDelaySeconds = (attempts: number): number =>
  Math.min(900, Math.max(15, 15 * 2 ** Math.min(attempts, 6)))

const secondsUntil = (iso: string): number =>
  Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 1_000))

const retryOrDead = (
  claim: ClaimedPushJob,
  attempts: number,
  responseStatus: number | null,
  error: string
): Effect.Effect<PushOutcome, PushDeliveryError, PushDeliveryRepository | AppConfig> =>
  Effect.gen(function*() {
    const repository = yield* PushDeliveryRepository
    const config = yield* AppConfig

    if (attempts >= config.maxPushAttempts) {
      yield* finalizeDead(
        claim,
        responseStatus,
        `delivery exhausted after ${attempts} attempts: ${error}`,
        false
      )
      return { _tag: "PermanentFailure" } as const
    }

    const delaySeconds = retryDelaySeconds(attempts)
    const availableAt = new Date(Date.now() + delaySeconds * 1_000).toISOString()
    yield* repository.finalizeRetry(claim, responseStatus, error, availableAt)
    return { _tag: "Retry", delaySeconds } as const
  })

export const processPushMessage = (
  message: DeliverPushCommand
): Effect.Effect<PushOutcome, PushDeliveryError, PushDeliveryRepository | WebPush | AppConfig> =>
  Effect.gen(function*() {
    const repository = yield* PushDeliveryRepository
    const webPush = yield* WebPush

    const claimResult = yield* repository.claim(message)
    if (!claimResult) return { _tag: "AlreadyProcessed" } as const
    if ("availableAt" in claimResult) {
      return { _tag: "Retry", delaySeconds: secondsUntil(claimResult.availableAt) } as const
    }
    const claim = claimResult

    const context = yield* repository.loadClaimedContext(claim)
    if (!context) {
      yield* finalizeDead(claim, null, "event or subscription no longer exists", false)
      return { _tag: "PermanentFailure" } as const
    }
    if (context.subscription.enabled !== 1) {
      yield* finalizeDead(claim, null, "push subscription is disabled", false)
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
        retryOrDead(claim, context.job.attempts, null, error.message)
      )
    )

    if (!(sent instanceof Response)) return sent

    if (sent.ok) {
      yield* finalizeSuccess(claim, sent.status)
      return { _tag: "Delivered" } as const
    }

    const details = yield* Effect.tryPromise({
      try: () => responseBody(sent),
      catch: () => `push service returned HTTP ${sent.status}`
    }).pipe(Effect.catch(() => Effect.succeed(`push service returned HTTP ${sent.status}`)))

    if (sent.status === 404 || sent.status === 410) {
      yield* finalizeDead(claim, sent.status, details || `push service returned HTTP ${sent.status}`, true)
      return { _tag: "PermanentFailure" } as const
    }

    if (sent.status === 408 || sent.status === 425 || sent.status === 429 || sent.status >= 500) {
      return yield* retryOrDead(
        claim,
        context.job.attempts,
        sent.status,
        details || `push service returned HTTP ${sent.status}`
      )
    }

    yield* finalizeDead(claim, sent.status, details || `push service returned HTTP ${sent.status}`, false)
    return { _tag: "PermanentFailure" } as const
  }).pipe(Effect.withSpan("PushDelivery.process", { attributes: { eventId: message.eventId } }))

export const processDeadLetterMessage = (
  message: DeliverPushCommand,
  reason = "Cloudflare Queue moved the message to the dead-letter queue"
): Effect.Effect<PushOutcome, PushDeliveryError, PushDeliveryRepository> =>
  Effect.gen(function*() {
    const repository = yield* PushDeliveryRepository
    const finalized = yield* repository.finalizeDeadLetter(message, reason)
    return finalized
      ? { _tag: "PermanentFailure" } as const
      : { _tag: "AlreadyProcessed" } as const
  }).pipe(Effect.withSpan("PushDelivery.deadLetter", { attributes: { eventId: message.eventId } }))
