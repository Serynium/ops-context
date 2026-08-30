import { Effect } from "effect"
import { badRequest, conflict, invalid, notFound, unauthorized, type AppError } from "./errors.js"
import { sha256Hex } from "./crypto.js"
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
  if (!subscription || typeof subscription !== "object") throw invalid("subscription is required")
  if (typeof subscription.endpoint !== "string" || !subscription.endpoint.startsWith("https://")) {
    throw invalid("subscription endpoint must be an HTTPS URL")
  }
  if (
    !subscription.keys ||
    typeof subscription.keys.p256dh !== "string" ||
    typeof subscription.keys.auth !== "string" ||
    subscription.keys.p256dh.length < 20 ||
    subscription.keys.auth.length < 8
  ) {
    throw invalid("subscription encryption keys are missing")
  }
}

const deriveRenewalCredential = (
  credential: string,
  id: string,
  endpoint: string
): Effect.Effect<string, AppError, CredentialCrypto> =>
  Effect.map(
    sha256Hex(`${credential}\u0000${id}\u0000${endpoint}`),
    (digest) => `${RENEWAL_CREDENTIAL_PREFIX}${digest}`
  )

const deriveEnrollmentCredential = (
  enrollmentKey: string,
  endpoint: string
): Effect.Effect<string, AppError, CredentialCrypto> =>
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

export const listSubscriptions: Effect.Effect<ReadonlyArray<PushSubscriptionView>, AppError, Database> =
  Effect.gen(function*() {
    const db = yield* Database
    const rows = yield* db.all<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions ORDER BY created_at DESC"
    )
    return rows.map(toSubscriptionView)
  })

export const findSubscriptionRow = (
  id: string
): Effect.Effect<PushSubscriptionRow, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const row = yield* db.first<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE id = ?",
      [id]
    )
    if (!row) return yield* Effect.fail(notFound("push subscription not found"))
    return row
  })

export const registerSubscription = (
  input: RegisterSubscriptionInput,
  userAgent: string
): Effect.Effect<SubscriptionCredentialResult, AppError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* Effect.try({
      try: () => validateSubscription(input.subscription),
      catch: (cause) =>
        typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === "AppError"
          ? (cause as AppError)
          : invalid("push subscription is invalid")
    })

    const now = nowIso()
    const existing = yield* db.first<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE endpoint = ?",
      [input.subscription.endpoint]
    )
    if (existing?.enabled === 0 && input.reactivate !== true) {
      return yield* Effect.fail(badRequest(
        "subscription_disabled",
        "this push installation is disabled and requires explicit re-enrollment"
      ))
    }
    const id = existing?.id ?? (yield* newId("sub"))
    const name = input.name?.trim().slice(0, 120) || existing?.name || "PWA device"
    if (!input.enrollment_key.startsWith("ops_enroll_") || input.enrollment_key.length < 54) {
      return yield* Effect.fail(invalid("a high-entropy PWA enrollment key is required"))
    }
    const credential = yield* deriveEnrollmentCredential(input.enrollment_key, input.subscription.endpoint)
    const credentialHash = yield* sha256Hex(credential)

    yield* db.run(
      `INSERT INTO push_subscriptions
       (id, name, endpoint, p256dh, auth, user_agent, enabled, last_seen_at,
        renewal_credential_hash, renewal_credential_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         name = excluded.name,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         enabled = 1,
         last_seen_at = excluded.last_seen_at,
         renewal_credential_hash = excluded.renewal_credential_hash,
         renewal_credential_issued_at = excluded.renewal_credential_issued_at,
         previous_renewal_credential_hash = NULL,
         previous_renewal_credential_valid_until = NULL,
         updated_at = excluded.updated_at
       WHERE push_subscriptions.enabled = 1 OR ? = 1`,
      [
        id,
        name,
        input.subscription.endpoint,
        input.subscription.keys.p256dh,
        input.subscription.keys.auth,
        userAgent.slice(0, 512),
        now,
        credentialHash,
        now,
        existing?.created_at ?? now,
        now,
        input.reactivate === true ? 1 : 0
      ]
    )

    const row = yield* db.first<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE endpoint = ?",
      [input.subscription.endpoint]
    )
    if (!row) return yield* Effect.fail(notFound("push subscription could not be saved"))
    if (row.enabled !== 1) {
      return yield* Effect.fail(badRequest(
        "subscription_disabled",
        "this push installation is disabled and requires explicit re-enrollment"
      ))
    }
    return { subscription: toSubscriptionView(row), renewal_credential: credential }
  })

export const renewSubscription = (
  id: string,
  credential: string,
  subscription: BrowserPushSubscription,
  userAgent: string
): Effect.Effect<SubscriptionCredentialResult, AppError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* Effect.try({
      try: () => validateSubscription(subscription),
      catch: (cause) =>
        typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === "AppError"
          ? (cause as AppError)
          : invalid("push subscription is invalid")
    })
    if (!credential.startsWith(RENEWAL_CREDENTIAL_PREFIX) || credential.length < 50) {
      return yield* Effect.fail(unauthorized("invalid push renewal credential"))
    }

    const current = yield* db.first<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE id = ?",
      [id]
    )
    if (!current || current.enabled !== 1) {
      return yield* Effect.fail(unauthorized("invalid push renewal credential"))
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
        return yield* Effect.fail(unauthorized("invalid push renewal credential"))
      }
      return {
        subscription: toSubscriptionView(current),
        renewal_credential: retryCredential
      }
    }

    if (current.renewal_credential_hash !== credentialHash) {
      return yield* Effect.fail(unauthorized("invalid push renewal credential"))
    }

    const endpointOwner = yield* db.first<{ readonly id: string }>(
      "SELECT id FROM push_subscriptions WHERE endpoint = ?",
      [subscription.endpoint]
    )
    if (endpointOwner && endpointOwner.id !== id) {
      return yield* Effect.fail(conflict("push endpoint belongs to another installation"))
    }

    const nextCredential = yield* deriveRenewalCredential(credential, id, subscription.endpoint)
    const nextHash = yield* sha256Hex(nextCredential)

    const retryValidUntil = new Date(Date.now() + RENEWAL_RETRY_GRACE_MS).toISOString()
    const result = yield* db.run(
      `UPDATE push_subscriptions
       SET endpoint = ?, p256dh = ?, auth = ?, user_agent = ?, last_seen_at = ?,
           previous_renewal_credential_hash = renewal_credential_hash,
           previous_renewal_credential_valid_until = ?,
           renewal_credential_hash = ?, renewal_credential_issued_at = ?, updated_at = ?
       WHERE id = ? AND enabled = 1 AND renewal_credential_hash = ?`,
      [
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        userAgent.slice(0, 512),
        now,
        retryValidUntil,
        nextHash,
        now,
        now,
        id,
        credentialHash
      ]
    )
    if ((result.meta.changes ?? 0) !== 1) {
      const committed = yield* db.first<PushSubscriptionRow>(
        "SELECT * FROM push_subscriptions WHERE id = ?",
        [id]
      )
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
      return yield* Effect.fail(unauthorized("invalid push renewal credential"))
    }

    return {
      subscription: toSubscriptionView(yield* findSubscriptionRow(id)),
      renewal_credential: nextCredential
    }
  })

export const updateSubscription = (
  id: string,
  patch: { readonly name?: string | undefined; readonly enabled?: boolean | undefined }
): Effect.Effect<PushSubscriptionView, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const current = yield* findSubscriptionRow(id)
    const name = patch.name === undefined ? current.name : patch.name.trim().slice(0, 120)
    if (!name) return yield* Effect.fail(invalid("subscription name cannot be empty"))
    const enabledPatch = patch.enabled === undefined ? null : patch.enabled ? 1 : 0
    if (current.enabled === 0 && enabledPatch === 1) {
      return yield* Effect.fail(invalid("disabled subscriptions must be re-enrolled from their installation"))
    }
    const result = yield* db.run(
      `UPDATE push_subscriptions
       SET name = ?,
           enabled = CASE WHEN ? IS NULL THEN enabled ELSE ? END,
           renewal_credential_hash = CASE WHEN ? = 0 THEN NULL ELSE renewal_credential_hash END,
           renewal_credential_issued_at = CASE WHEN ? = 0 THEN NULL ELSE renewal_credential_issued_at END,
           previous_renewal_credential_hash = CASE WHEN ? = 0 THEN NULL ELSE previous_renewal_credential_hash END,
           previous_renewal_credential_valid_until = CASE WHEN ? = 0 THEN NULL ELSE previous_renewal_credential_valid_until END,
           updated_at = ?
       WHERE id = ? AND (COALESCE(?, -1) <> 1 OR enabled = 1)`,
      [name, enabledPatch, enabledPatch, enabledPatch, enabledPatch, enabledPatch, enabledPatch, nowIso(), id, enabledPatch]
    )
    if ((result.meta.changes ?? 0) !== 1 && enabledPatch === 1) {
      return yield* Effect.fail(invalid("disabled subscriptions must be re-enrolled from their installation"))
    }
    return toSubscriptionView(yield* findSubscriptionRow(id))
  })

export const deleteSubscription = (id: string): Effect.Effect<void, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* findSubscriptionRow(id)
    yield* db.run("DELETE FROM push_subscriptions WHERE id = ?", [id])
  })

export const listEnabledSubscriptionRows: Effect.Effect<ReadonlyArray<PushSubscriptionRow>, AppError, Database> =
  Effect.gen(function*() {
    const db = yield* Database
    return yield* db.all<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE enabled = 1 ORDER BY created_at"
    )
  })
