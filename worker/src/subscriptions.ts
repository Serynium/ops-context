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
import { CredentialCrypto, Database } from "./services.js"
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

export const listSubscriptions: Effect.Effect<ReadonlyArray<PushSubscriptionView>, RepositoryUnavailable, Database> =
  Effect.gen(function*() {
    const db = yield* Database
    const rows = yield* db.all<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions ORDER BY created_at DESC"
    )
    return rows.map(toSubscriptionView)
  })

export const findSubscriptionRow = (
  id: string
): Effect.Effect<PushSubscriptionRow, SubscriptionNotFound | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const row = yield* db.first<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE id = ?",
      [id]
    )
    if (!row) return yield* Effect.fail(subscriptionNotFound())
    return row
  })

export const registerSubscription = (
  input: RegisterSubscriptionInput,
  userAgent: string
): Effect.Effect<PushSubscriptionView, InvalidSubscription | SubscriptionNotFound | RepositoryUnavailable | CryptographyUnavailable, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* Effect.try({
      try: () => validateSubscription(input.subscription),
      catch: (cause) =>
        typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === "InvalidSubscription"
          ? (cause as InvalidSubscription)
          : invalidSubscription("push subscription is invalid")
    })

    const now = nowIso()
    const existing = yield* db.first<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE endpoint = ?",
      [input.subscription.endpoint]
    )
    const id = existing?.id ?? (yield* newId("sub"))
    const name = input.name?.trim().slice(0, 120) || existing?.name || "PWA device"

    yield* db.run(
      `INSERT INTO push_subscriptions
       (id, name, endpoint, p256dh, auth, user_agent, enabled, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         name = excluded.name,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         enabled = 1,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
      [
        id,
        name,
        input.subscription.endpoint,
        input.subscription.keys.p256dh,
        input.subscription.keys.auth,
        userAgent.slice(0, 512),
        now,
        existing?.created_at ?? now,
        now
      ]
    )

    const row = yield* db.first<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE endpoint = ?",
      [input.subscription.endpoint]
    )
    if (!row) return yield* Effect.fail(subscriptionNotFound("push subscription could not be saved"))
    return toSubscriptionView(row)
  })

export const updateSubscription = (
  id: string,
  patch: { readonly name?: string | undefined; readonly enabled?: boolean | undefined }
): Effect.Effect<PushSubscriptionView, InvalidSubscription | SubscriptionNotFound | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const current = yield* findSubscriptionRow(id)
    const name = patch.name === undefined ? current.name : patch.name.trim().slice(0, 120)
    if (!name) return yield* Effect.fail(invalidSubscription("subscription name cannot be empty"))
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0
    yield* db.run(
      "UPDATE push_subscriptions SET name = ?, enabled = ?, updated_at = ? WHERE id = ?",
      [name, enabled, nowIso(), id]
    )
    return toSubscriptionView(yield* findSubscriptionRow(id))
  })

export const deleteSubscription = (id: string): Effect.Effect<void, SubscriptionNotFound | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* findSubscriptionRow(id)
    yield* db.run("DELETE FROM push_subscriptions WHERE id = ?", [id])
  })

export const listEnabledSubscriptionRows: Effect.Effect<ReadonlyArray<PushSubscriptionRow>, RepositoryUnavailable, Database> =
  Effect.gen(function*() {
    const db = yield* Database
    return yield* db.all<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE enabled = 1 ORDER BY created_at"
    )
  })
