import { Effect } from "effect"
import {
  invalidRenewalCredential,
  invalidSubscription,
  subscriptionDisabled,
  subscriptionEndpointConflict,
  subscriptionEnrollmentSuperseded,
  subscriptionNotFound,
  subscriptionRevoked,
  type CryptographyUnavailable,
  type InvalidRenewalCredential,
  type InvalidSubscription,
  type RepositoryUnavailable,
  type SubscriptionDisabled,
  type SubscriptionEndpointConflict,
  type SubscriptionEnrollmentSuperseded,
  type SubscriptionNotFound,
  type SubscriptionRevoked
} from "./errors.js"
import { newId, nowIso } from "./ids.js"
import { SubscriptionsRepository, type PushSubscriptionRow } from "./repositories.js"
import { CredentialCrypto, sha256Hex } from "./services.js"
import type { PushSubscriptionView } from "./types.js"

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
  readonly enrollment_key: string
  readonly reactivate?: boolean | undefined
  readonly subscription: BrowserPushSubscription
}

export interface SubscriptionCredentialResult {
  readonly subscription: PushSubscriptionView
  readonly renewal_credential: string
}

const RENEWAL_CREDENTIAL_PREFIX = "ops_pwa_"
const RENEWAL_RETRY_GRACE_MS = 5 * 60 * 1_000

export type SubscriptionOperationError = InvalidSubscription | SubscriptionNotFound |
  SubscriptionDisabled | SubscriptionEnrollmentSuperseded | InvalidRenewalCredential |
  SubscriptionRevoked | SubscriptionEndpointConflict | RepositoryUnavailable |
  CryptographyUnavailable

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

const deriveRenewalCredential = (
  credential: string,
  id: string,
  endpoint: string
): Effect.Effect<string, CryptographyUnavailable, CredentialCrypto> =>
  Effect.map(
    sha256Hex(`${credential}\u0000${id}\u0000${endpoint}`),
    (digest) => `${RENEWAL_CREDENTIAL_PREFIX}${digest}`
  )

const deriveEnrollmentCredential = (
  enrollmentKey: string,
  endpoint: string
): Effect.Effect<string, CryptographyUnavailable, CredentialCrypto> =>
  Effect.map(
    sha256Hex(`${enrollmentKey}\u0000${endpoint}`),
    (digest) => `${RENEWAL_CREDENTIAL_PREFIX}${digest}`
  )

const isIdempotentRenewalRetry = (
  row: PushSubscriptionRow,
  credentialHash: string,
  nextHash: string,
  endpoint: string,
  now: string
): boolean =>
  row.enabled === 1 &&
  row.previous_renewal_credential_hash === credentialHash &&
  row.previous_renewal_credential_valid_until !== null &&
  row.previous_renewal_credential_valid_until >= now &&
  row.endpoint === endpoint &&
  row.renewal_credential_hash === nextHash

export const listSubscriptions: Effect.Effect<ReadonlyArray<PushSubscriptionView>, RepositoryUnavailable, SubscriptionsRepository> =
  Effect.gen(function*() {
    const repository = yield* SubscriptionsRepository
    const rows = yield* repository.list
    return rows.map(toSubscriptionView)
  })

export const findSubscriptionRow = (
  id: string
): Effect.Effect<PushSubscriptionRow, SubscriptionNotFound | RepositoryUnavailable, SubscriptionsRepository> =>
  Effect.gen(function*() {
    const repository = yield* SubscriptionsRepository
    const row = yield* repository.findById(id)
    if (!row) return yield* Effect.fail(subscriptionNotFound())
    return row
  })

export const registerSubscription = (
  input: RegisterSubscriptionInput,
  userAgent: string
): Effect.Effect<SubscriptionCredentialResult, SubscriptionOperationError, SubscriptionsRepository | CredentialCrypto> =>
  Effect.gen(function*() {
    const repository = yield* SubscriptionsRepository
    yield* Effect.try({
      try: () => validateSubscription(input.subscription),
      catch: (cause) =>
        typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === "InvalidSubscription"
          ? (cause as InvalidSubscription)
          : invalidSubscription("push subscription is invalid")
    })

    const now = nowIso()
    const existing = yield* repository.findByEndpoint(input.subscription.endpoint)
    if (existing?.enabled === 0 && input.reactivate !== true) {
      return yield* Effect.fail(subscriptionDisabled())
    }
    const id = existing?.id ?? (yield* newId("sub"))
    const name = input.name?.trim().slice(0, 120) || existing?.name || "PWA device"
    if (!input.enrollment_key.startsWith("ops_enroll_") || input.enrollment_key.length < 54) {
      return yield* Effect.fail(invalidSubscription("a high-entropy PWA enrollment key is required"))
    }
    const credential = yield* deriveEnrollmentCredential(input.enrollment_key, input.subscription.endpoint)
    const credentialHash = yield* sha256Hex(credential)

    const changed = yield* repository.enroll({
      id,
      name,
      endpoint: input.subscription.endpoint,
      p256dh: input.subscription.keys.p256dh,
      auth: input.subscription.keys.auth,
      userAgent: userAgent.slice(0, 512),
      credentialHash,
      explicitlyEnrolled: input.reactivate === true ? 1 : 0,
      now,
      createdAt: existing?.created_at ?? now
    })

    const row = yield* repository.findByEndpoint(input.subscription.endpoint)
    if (!row) return yield* Effect.fail(subscriptionNotFound("push subscription could not be saved"))
    if (row.enabled !== 1) {
      return yield* Effect.fail(subscriptionDisabled())
    }
    if (changed !== 1) {
      return yield* Effect.fail(subscriptionEnrollmentSuperseded())
    }
    return { subscription: toSubscriptionView(row), renewal_credential: credential }
  })

export const renewSubscription = (
  id: string,
  credential: string,
  subscription: BrowserPushSubscription,
  userAgent: string
): Effect.Effect<SubscriptionCredentialResult, SubscriptionOperationError, SubscriptionsRepository | CredentialCrypto> =>
  Effect.gen(function*() {
    const repository = yield* SubscriptionsRepository
    yield* Effect.try({
      try: () => validateSubscription(subscription),
      catch: (cause) =>
        typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === "InvalidSubscription"
          ? (cause as InvalidSubscription)
          : invalidSubscription("push subscription is invalid")
    })
    if (!credential.startsWith(RENEWAL_CREDENTIAL_PREFIX) || credential.length < 50) {
      return yield* Effect.fail(invalidRenewalCredential())
    }

    const current = yield* repository.findById(id)
    if (!current) {
      return yield* Effect.fail(invalidRenewalCredential())
    }
    if (current.enabled !== 1) {
      return yield* Effect.fail(subscriptionRevoked())
    }

    const credentialHash = yield* sha256Hex(credential)
    const now = nowIso()

    if (current.previous_renewal_credential_hash === credentialHash) {
      const retryCredential = yield* deriveRenewalCredential(credential, id, subscription.endpoint)
      const retryHash = yield* sha256Hex(retryCredential)
      if (!isIdempotentRenewalRetry(
        current,
        credentialHash,
        retryHash,
        subscription.endpoint,
        now
      )) {
        return yield* Effect.fail(invalidRenewalCredential())
      }
      return {
        subscription: toSubscriptionView(current),
        renewal_credential: retryCredential
      }
    }

    if (current.renewal_credential_hash !== credentialHash) {
      return yield* Effect.fail(invalidRenewalCredential())
    }

    const endpointOwner = yield* repository.findByEndpoint(subscription.endpoint)
    if (endpointOwner && endpointOwner.id !== id) {
      return yield* Effect.fail(subscriptionEndpointConflict())
    }

    const nextCredential = yield* deriveRenewalCredential(credential, id, subscription.endpoint)
    const nextHash = yield* sha256Hex(nextCredential)

    const retryValidUntil = new Date(Date.now() + RENEWAL_RETRY_GRACE_MS).toISOString()
    const changed = yield* repository.renew({
      id,
      expectedCredentialHash: credentialHash,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent.slice(0, 512),
      retryValidUntil,
      nextCredentialHash: nextHash,
      now
    })
    if (changed !== 1) {
      const committed = yield* repository.findById(id)
      if (committed && isIdempotentRenewalRetry(
        committed,
        credentialHash,
        nextHash,
        subscription.endpoint,
        now
      )) {
        return {
          subscription: toSubscriptionView(committed),
          renewal_credential: nextCredential
        }
      }
      if (committed?.enabled === 0) {
        return yield* Effect.fail(subscriptionRevoked())
      }
      return yield* Effect.fail(invalidRenewalCredential())
    }

    return {
      subscription: toSubscriptionView(yield* findSubscriptionRow(id)),
      renewal_credential: nextCredential
    }
  })

export const updateSubscription = (
  id: string,
  patch: { readonly name?: string | undefined; readonly enabled?: boolean | undefined }
): Effect.Effect<PushSubscriptionView, InvalidSubscription | SubscriptionNotFound | RepositoryUnavailable, SubscriptionsRepository> =>
  Effect.gen(function*() {
    const repository = yield* SubscriptionsRepository
    const current = yield* findSubscriptionRow(id)
    const name = patch.name === undefined ? current.name : patch.name.trim().slice(0, 120)
    if (!name) return yield* Effect.fail(invalidSubscription("subscription name cannot be empty"))
    const enabledPatch = patch.enabled === undefined ? null : patch.enabled ? 1 : 0
    if (current.enabled === 0 && enabledPatch === 1) {
      return yield* Effect.fail(invalidSubscription("disabled subscriptions must be re-enrolled from their installation"))
    }
    const changed = yield* repository.update(id, name, enabledPatch, nowIso())
    if (changed !== 1 && enabledPatch === 1) {
      return yield* Effect.fail(invalidSubscription("disabled subscriptions must be re-enrolled from their installation"))
    }
    return toSubscriptionView(yield* findSubscriptionRow(id))
  })

export const deleteSubscription = (id: string): Effect.Effect<void, SubscriptionNotFound | RepositoryUnavailable, SubscriptionsRepository> =>
  Effect.gen(function*() {
    const repository = yield* SubscriptionsRepository
    yield* findSubscriptionRow(id)
    yield* repository.remove(id, nowIso())
  })

export const listEnabledSubscriptionRows: Effect.Effect<ReadonlyArray<PushSubscriptionRow>, RepositoryUnavailable, SubscriptionsRepository> =
  Effect.gen(function*() {
    const repository = yield* SubscriptionsRepository
    return yield* repository.listEnabled
  })
