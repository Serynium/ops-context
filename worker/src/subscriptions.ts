import { Effect } from "effect"
import {
  invalidSubscription,
  subscriptionNotFound,
  type CryptographyUnavailable,
  type InvalidSubscription,
  type RepositoryUnavailable,
  type SubscriptionNotFound
} from "./errors.js"
import { newId, nowIso } from "./ids.js"
import { SubscriptionsRepository } from "./repositories.js"
import { CredentialCrypto } from "./services.js"
import type { PushSubscriptionRow, PushSubscriptionView } from "./types.js"

export interface BrowserPushSubscription {
  readonly endpoint: string
  readonly expirationTime?: number | null | undefined
  readonly keys: {
    readonly p256dh: string
    readonly auth: string
  }
}

export interface RegisterSubscriptionInput {
  readonly name?: string | undefined
  readonly subscription: BrowserPushSubscription
}

const endpointHost = (endpoint: string): string => {
  try {
    return new URL(endpoint).host
  } catch {
    return "unknown"
  }
}

export const toSubscriptionView = (row: PushSubscriptionRow): PushSubscriptionView => ({
  id: row.id,
  name: row.name,
  enabled: row.enabled === 1,
  endpoint_host: endpointHost(row.endpoint),
  user_agent: row.user_agent,
  last_seen_at: row.last_seen_at,
  created_at: row.created_at,
  updated_at: row.updated_at
})

const validateSubscription = (subscription: BrowserPushSubscription): void => {
  if (!subscription || typeof subscription !== "object") throw invalidSubscription("subscription is required")
  if (typeof subscription.endpoint !== "string" || !subscription.endpoint.startsWith("https://")) {
    throw invalidSubscription("subscription endpoint must be an HTTPS URL")
  }
  if (
    !subscription.keys ||
    typeof subscription.keys.p256dh !== "string" ||
    typeof subscription.keys.auth !== "string" ||
    subscription.keys.p256dh.length < 20 ||
    subscription.keys.auth.length < 8
  ) {
    throw invalidSubscription("subscription encryption keys are missing")
  }
}

export const listSubscriptions: Effect.Effect<ReadonlyArray<PushSubscriptionView>, RepositoryUnavailable, SubscriptionsRepository> =
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionsRepository
    const rows = yield* subscriptions.list
    return rows.map(toSubscriptionView)
  })

export const findSubscriptionRow = (
  id: string
): Effect.Effect<PushSubscriptionRow, SubscriptionNotFound | RepositoryUnavailable, SubscriptionsRepository> =>
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionsRepository
    const row = yield* subscriptions.findById(id)
    if (!row) return yield* Effect.fail(subscriptionNotFound())
    return row
  })

export const registerSubscription = (
  input: RegisterSubscriptionInput,
  userAgent: string
): Effect.Effect<PushSubscriptionView, InvalidSubscription | SubscriptionNotFound | RepositoryUnavailable | CryptographyUnavailable, SubscriptionsRepository | CredentialCrypto> =>
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionsRepository
    yield* Effect.try({
      try: () => validateSubscription(input.subscription),
      catch: (cause) =>
        typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === "InvalidSubscription"
          ? (cause as InvalidSubscription)
          : invalidSubscription("push subscription is invalid")
    })

    const now = nowIso()
    const existing = yield* subscriptions.findByEndpoint(input.subscription.endpoint)
    const id = existing?.id ?? (yield* newId("sub"))
    const name = input.name?.trim().slice(0, 120) || existing?.name || "PWA device"

    yield* subscriptions.upsert({ id, name, endpoint: input.subscription.endpoint, p256dh: input.subscription.keys.p256dh,
      auth: input.subscription.keys.auth, userAgent: userAgent.slice(0, 512), now, createdAt: existing?.created_at ?? now })

    const row = yield* subscriptions.findByEndpoint(input.subscription.endpoint)
    if (!row) return yield* Effect.fail(subscriptionNotFound("push subscription could not be saved"))
    return toSubscriptionView(row)
  })

export const updateSubscription = (
  id: string,
  patch: { readonly name?: string | undefined; readonly enabled?: boolean | undefined }
): Effect.Effect<PushSubscriptionView, InvalidSubscription | SubscriptionNotFound | RepositoryUnavailable, SubscriptionsRepository> =>
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionsRepository
    const current = yield* findSubscriptionRow(id)
    const name = patch.name === undefined ? current.name : patch.name.trim().slice(0, 120)
    if (!name) return yield* Effect.fail(invalidSubscription("subscription name cannot be empty"))
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0
    yield* subscriptions.update(id, name, enabled, nowIso())
    return toSubscriptionView(yield* findSubscriptionRow(id))
  })

export const deleteSubscription = (id: string): Effect.Effect<void, SubscriptionNotFound | RepositoryUnavailable, SubscriptionsRepository> =>
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionsRepository
    yield* findSubscriptionRow(id)
    yield* subscriptions.delete(id)
  })

export const listEnabledSubscriptionRows: Effect.Effect<ReadonlyArray<PushSubscriptionRow>, RepositoryUnavailable, SubscriptionsRepository> =
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionsRepository
    return yield* subscriptions.listEnabled
  })
