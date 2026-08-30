import { Effect } from "effect"
import { conflict, invalid, notFound, unauthorized, type AppError } from "./errors.js"
import { randomToken, sha256Hex } from "./crypto.js"
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

const issueRenewalCredential = Effect.gen(function*() {
  const credential = `${RENEWAL_CREDENTIAL_PREFIX}${yield* randomToken(32)}`
  return { credential, hash: yield* sha256Hex(credential) }
})

const deriveRenewalCredential = (
  credential: string,
  id: string,
  endpoint: string
): Effect.Effect<string, AppError, CredentialCrypto> =>
  Effect.map(
    sha256Hex(`${credential}\u0000${id}\u0000${endpoint}`),
    (digest) => `${RENEWAL_CREDENTIAL_PREFIX}${digest}`
  )

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
    const id = existing?.id ?? (yield* newId("sub"))
    const name = input.name?.trim().slice(0, 120) || existing?.name || "PWA device"
    const renewal = yield* issueRenewalCredential

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
         updated_at = excluded.updated_at`,
      [
        id,
        name,
        input.subscription.endpoint,
        input.subscription.keys.p256dh,
        input.subscription.keys.auth,
        userAgent.slice(0, 512),
        now,
        renewal.hash,
        now,
        existing?.created_at ?? now,
        now
      ]
    )

    const row = yield* db.first<PushSubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE endpoint = ?",
      [input.subscription.endpoint]
    )
    if (!row) return yield* Effect.fail(notFound("push subscription could not be saved"))
    return { subscription: toSubscriptionView(row), renewal_credential: renewal.credential }
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

    if (
      current.previous_renewal_credential_hash === credentialHash &&
      current.previous_renewal_credential_valid_until !== null &&
      current.previous_renewal_credential_valid_until >= now &&
      current.endpoint === subscription.endpoint
    ) {
      const retryCredential = yield* deriveRenewalCredential(credential, id, subscription.endpoint)
      const retryHash = yield* sha256Hex(retryCredential)
      if (current.renewal_credential_hash !== retryHash) {
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
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0
    if (current.enabled === 0 && enabled === 1) {
      return yield* Effect.fail(invalid("disabled subscriptions must be re-enrolled from their installation"))
    }
    yield* db.run(
      `UPDATE push_subscriptions
       SET name = ?, enabled = ?,
           renewal_credential_hash = CASE WHEN ? = 1 THEN renewal_credential_hash ELSE NULL END,
           renewal_credential_issued_at = CASE WHEN ? = 1 THEN renewal_credential_issued_at ELSE NULL END,
           previous_renewal_credential_hash = CASE WHEN ? = 1 THEN previous_renewal_credential_hash ELSE NULL END,
           previous_renewal_credential_valid_until = CASE WHEN ? = 1 THEN previous_renewal_credential_valid_until ELSE NULL END,
           updated_at = ?
       WHERE id = ?`,
      [name, enabled, enabled, enabled, enabled, enabled, nowIso(), id]
    )
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
