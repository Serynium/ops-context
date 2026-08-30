import { env } from "cloudflare:workers"
import { createExecutionContext } from "cloudflare:test"
import { Effect, Layer } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import worker from "../src/index.js"
import { D1RepositoriesLive, EventsRepository } from "../src/repositories.js"
import { CredentialCrypto } from "../src/services.js"
import {
  deleteSubscription,
  listSubscriptions,
  registerSubscription,
  updateSubscription
} from "../src/subscriptions.js"

const subscription = (endpoint: string) => ({
  endpoint,
  expirationTime: null,
  keys: {
    p256dh: "p256dh-test-key-with-enough-characters",
    auth: "auth-test-key"
  }
})

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const seed = async (
  id: string,
  credential: string,
  endpoint: string,
  enabled = true
): Promise<void> => {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO push_subscriptions
     (id, name, endpoint, p256dh, auth, user_agent, enabled, last_seen_at,
      renewal_credential_hash, renewal_credential_issued_at, created_at, updated_at)
     VALUES (?, 'Test installation', ?, 'p256dh-test-key-with-enough-characters',
             'auth-test-key', 'test', ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    endpoint,
    enabled ? 1 : 0,
    now,
    await sha256Hex(credential),
    now,
    now,
    now
  ).run()
}

const renew = (
  id: string,
  credential: string,
  endpoint: string
): Promise<Response> => worker.fetch(new Request(
  `https://ops.example.com/api/v1/push/subscriptions/${encodeURIComponent(id)}/renew`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ subscription: subscription(endpoint) })
  }
) as Parameters<typeof worker.fetch>[0], env, createExecutionContext())

describe.sequential("installation-scoped push renewal credentials", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE id LIKE 'sub_renewal_%'").run()
  })

  it("returns a one-time credential at enrollment while storing only its hash", async () => {
    const enrollmentKey = `ops_enroll_${"z".repeat(43)}`
    const input = {
      name: "Enrollment",
      enrollment_key: enrollmentKey,
      subscription: subscription("https://push.example.test/enrollment")
    }
    const layer = Layer.mergeAll(D1RepositoriesLive(env.DB), CredentialCrypto.layer)
    const enroll = () => Effect.runPromise(
      registerSubscription(input, "test agent").pipe(Effect.provide(layer))
    )
    const [result, duplicate] = await Promise.all([enroll(), enroll()])

    expect(result.renewal_credential).toMatch(/^ops_pwa_[A-Za-z0-9_-]{40,}$/u)
    expect(duplicate).toMatchObject({
      subscription: { id: result.subscription.id },
      renewal_credential: result.renewal_credential
    })
    const row = await env.DB.prepare(
      "SELECT renewal_credential_hash FROM push_subscriptions WHERE id = ?"
    ).bind(result.subscription.id).first<{ readonly renewal_credential_hash: string }>()
    expect(row?.renewal_credential_hash).toBe(await sha256Hex(result.renewal_credential))
    expect(JSON.stringify(row)).not.toContain(result.renewal_credential)
  })

  it("does not let delayed silent enrollment supersede explicit enrollment", async () => {
    const endpoint = "https://push.example.test/explicit-wins"
    const layer = Layer.mergeAll(D1RepositoriesLive(env.DB), CredentialCrypto.layer)
    const explicit = await Effect.runPromise(registerSubscription({
      enrollment_key: `ops_enroll_${"v".repeat(43)}`,
      reactivate: true,
      subscription: subscription(endpoint)
    }, "test agent").pipe(Effect.provide(layer)))

    await expect(Effect.runPromise(registerSubscription({
      enrollment_key: `ops_enroll_${"w".repeat(43)}`,
      reactivate: false,
      subscription: subscription(endpoint)
    }, "test agent").pipe(Effect.provide(layer)))).rejects.toMatchObject({
      _tag: "SubscriptionEnrollmentSuperseded"
    })

    const row = await env.DB.prepare(
      "SELECT explicitly_enrolled, renewal_credential_hash FROM push_subscriptions WHERE id = ?"
    ).bind(explicit.subscription.id).first<{
      readonly explicitly_enrolled: number
      readonly renewal_credential_hash: string | null
    }>()
    expect(row).toMatchObject({
      explicitly_enrolled: 1,
      renewal_credential_hash: await sha256Hex(explicit.renewal_credential)
    })
  })

  it("renews without administrator identity and replaces the endpoint and credential", async () => {
    const credential = `ops_pwa_${"a".repeat(43)}`
    await seed("sub_renewal_valid", credential, "https://push.example.test/old")

    const response = await renew(
      "sub_renewal_valid",
      credential,
      "https://push.example.test/replacement"
    )
    expect(response.status).toBe(200)
    const body = await response.json<{
      readonly subscription: { readonly id: string }
      readonly renewal_credential: string
    }>()
    expect(body.subscription.id).toBe("sub_renewal_valid")
    expect(body.renewal_credential).not.toBe(credential)

    const row = await env.DB.prepare(
      "SELECT endpoint, renewal_credential_hash FROM push_subscriptions WHERE id = ?"
    ).bind("sub_renewal_valid").first<{
      readonly endpoint: string
      readonly renewal_credential_hash: string
    }>()
    expect(row?.endpoint).toBe("https://push.example.test/replacement")
    expect(row?.renewal_credential_hash).toBe(await sha256Hex(body.renewal_credential))

    const retry = await renew(
      "sub_renewal_valid",
      credential,
      "https://push.example.test/replacement"
    )
    expect(retry.status).toBe(200)
    await expect(retry.json()).resolves.toMatchObject({
      renewal_credential: body.renewal_credential
    })
  })

  it("does not let a credential mutate another installation", async () => {
    const firstCredential = `ops_pwa_${"b".repeat(43)}`
    const secondCredential = `ops_pwa_${"c".repeat(43)}`
    await seed("sub_renewal_first", firstCredential, "https://push.example.test/first")
    await seed("sub_renewal_second", secondCredential, "https://push.example.test/second")

    const response = await renew(
      "sub_renewal_second",
      firstCredential,
      "https://push.example.test/attacker"
    )
    expect(response.status).toBe(401)
    const row = await env.DB.prepare(
      "SELECT endpoint FROM push_subscriptions WHERE id = 'sub_renewal_second'"
    ).first<{ readonly endpoint: string }>()
    expect(row?.endpoint).toBe("https://push.example.test/second")
  })

  it("returns the committed credential when concurrent renewal loses the update race", async () => {
    const credential = `ops_pwa_${"h".repeat(43)}`
    const endpoint = "https://push.example.test/concurrent-new"
    await seed("sub_renewal_concurrent", credential, "https://push.example.test/concurrent-old")

    const [first, second] = await Promise.all([
      renew("sub_renewal_concurrent", credential, endpoint),
      renew("sub_renewal_concurrent", credential, endpoint)
    ])
    expect([first.status, second.status]).toEqual([200, 200])
    const [firstBody, secondBody] = await Promise.all([
      first.json<{ readonly renewal_credential: string }>(),
      second.json<{ readonly renewal_credential: string }>()
    ])
    expect(secondBody.renewal_credential).toBe(firstBody.renewal_credential)
  })

  it("rejects a credential belonging to a disabled installation", async () => {
    const credential = `ops_pwa_${"d".repeat(43)}`
    await seed("sub_renewal_revoked", credential, "https://push.example.test/revoked", false)

    const response = await renew(
      "sub_renewal_revoked",
      credential,
      "https://push.example.test/revoked-new"
    )
    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({ error: "subscription_revoked" })
  })

  it("requires re-enrollment instead of enabling a row with a revoked credential", async () => {
    const credential = `ops_pwa_${"f".repeat(43)}`
    await seed("sub_renewal_reenable", credential, "https://push.example.test/reenable")
    const database = D1RepositoriesLive(env.DB)

    await Effect.runPromise(updateSubscription("sub_renewal_reenable", { enabled: false }).pipe(
      Effect.provide(database)
    ))
    await expect(Effect.runPromise(updateSubscription("sub_renewal_reenable", { enabled: true }).pipe(
      Effect.provide(database)
    ))).rejects.toMatchObject({ _tag: "InvalidSubscription" })

    const row = await env.DB.prepare(
      `SELECT enabled, renewal_credential_hash, previous_renewal_credential_hash
       FROM push_subscriptions WHERE id = 'sub_renewal_reenable'`
    ).first<{
      readonly enabled: number
      readonly renewal_credential_hash: string | null
      readonly previous_renewal_credential_hash: string | null
    }>()
    expect(row).toMatchObject({
      enabled: 0,
      renewal_credential_hash: null,
      previous_renewal_credential_hash: null
    })
  })

  it("preserves revocation when renaming a disabled installation", async () => {
    const credential = `ops_pwa_${"i".repeat(43)}`
    await seed("sub_renewal_rename_disabled", credential, "https://push.example.test/rename", false)
    const database = D1RepositoriesLive(env.DB)

    const renamed = await Effect.runPromise(
      updateSubscription("sub_renewal_rename_disabled", { name: "Renamed installation" }).pipe(
        Effect.provide(database)
      )
    )
    expect(renamed).toMatchObject({ name: "Renamed installation", enabled: false })

    const row = await env.DB.prepare(
      `SELECT enabled, renewal_credential_hash, previous_renewal_credential_hash
       FROM push_subscriptions WHERE id = 'sub_renewal_rename_disabled'`
    ).first<{
      readonly enabled: number
      readonly renewal_credential_hash: string | null
      readonly previous_renewal_credential_hash: string | null
    }>()
    expect(row).toMatchObject({
      enabled: 0,
      renewal_credential_hash: await sha256Hex(credential),
      previous_renewal_credential_hash: null
    })
  })

  it("keeps legacy-disabled rows disabled until explicit re-enrollment", async () => {
    const credential = `ops_pwa_${"g".repeat(43)}`
    const endpoint = "https://push.example.test/legacy-disabled"
    await seed("sub_renewal_legacy_disabled", credential, endpoint, false)
    const layer = Layer.mergeAll(D1RepositoriesLive(env.DB), CredentialCrypto.layer)
    const input = {
      enrollment_key: `ops_enroll_${"y".repeat(43)}`,
      subscription: subscription(endpoint)
    }

    await expect(Effect.runPromise(
      registerSubscription({ ...input, reactivate: false }, "test agent").pipe(Effect.provide(layer))
    )).rejects.toMatchObject({ _tag: "SubscriptionDisabled" })

    const reenrolled = await Effect.runPromise(
      registerSubscription({ ...input, reactivate: true }, "test agent").pipe(Effect.provide(layer))
    )
    expect(reenrolled.subscription).toMatchObject({
      id: "sub_renewal_legacy_disabled",
      enabled: true
    })
    expect(reenrolled.renewal_credential).toMatch(/^ops_pwa_/u)
  })

  it("keeps removed endpoints tombstoned until explicit re-enrollment", async () => {
    const credential = `ops_pwa_${"j".repeat(43)}`
    const endpoint = "https://push.example.test/removed-legacy"
    const id = "sub_renewal_removed_legacy"
    await seed(id, credential, endpoint)
    const database = D1RepositoriesLive(env.DB)
    const layer = Layer.mergeAll(database, CredentialCrypto.layer)
    const input = {
      enrollment_key: `ops_enroll_${"x".repeat(43)}`,
      subscription: subscription(endpoint)
    }
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO projects
         (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
         VALUES ('prj_renewal_removed', 'Removed', 'renewal-removed', '',
                 'renewal-removed-hash', 1, 'info', ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO events
         (id, project_id, source, type, level, title, body, fingerprint,
          payload_json, actions_json, occurred_at, created_at)
         VALUES ('evt_renewal_removed', 'prj_renewal_removed', 'test', 'test', 'info',
                 'Queued before removal', '', 'renewal-removed', '{}', '[]', ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO push_jobs
         (event_id, subscription_id, state, attempts, available_at, last_error, updated_at)
         VALUES ('evt_renewal_removed', ?, 'queued', 0, ?, '', ?)`
      ).bind(id, now, now)
    ])

    await Effect.runPromise(deleteSubscription(id).pipe(Effect.provide(database)))
    await expect(Effect.runPromise(
      registerSubscription({ ...input, reactivate: false }, "test agent").pipe(Effect.provide(layer))
    )).rejects.toMatchObject({ _tag: "SubscriptionDisabled" })
    await expect(Effect.runPromise(listSubscriptions.pipe(Effect.provide(database)))).resolves.not.toContainEqual(
      expect.objectContaining({ id })
    )
    const visibleCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM push_subscriptions WHERE deleted_at IS NULL AND id = ?"
    ).bind(id).first<{ readonly count: number }>()
    expect(visibleCount?.count).toBe(0)

    const tombstone = await env.DB.prepare(
      `SELECT enabled, deleted_at, renewal_credential_hash
       FROM push_subscriptions WHERE id = ?`
    ).bind(id).first<{
      readonly enabled: number
      readonly deleted_at: string | null
      readonly renewal_credential_hash: string | null
    }>()
    expect(tombstone).toMatchObject({
      enabled: 0,
      renewal_credential_hash: null
    })
    expect(tombstone?.deleted_at).not.toBeNull()
    const queuedJob = await env.DB.prepare(
      "SELECT state FROM push_jobs WHERE event_id = 'evt_renewal_removed' AND subscription_id = ?"
    ).bind(id).first<{ readonly state: string }>()
    expect(queuedJob).toBeNull()

    const reenrolled = await Effect.runPromise(
      registerSubscription({ ...input, reactivate: true }, "test agent").pipe(Effect.provide(layer))
    )
    expect(reenrolled.subscription).toMatchObject({ id, enabled: true })

    await Effect.runPromise(Effect.gen(function*() {
      const events = yield* EventsRepository
      yield* events.initializeIngestion({
        id: "evt_renewal_after_removal",
        externalId: null,
        projectId: "prj_renewal_removed",
        source: "test",
        type: "test",
        level: "info",
        title: "Fanout after removal",
        body: "",
        fingerprint: "renewal-after-removal",
        payloadJson: "{}",
        actionsJson: "[]",
        occurredAt: now,
        createdAt: now,
        silenceId: null
      }, [{ id, generation: 0 }])
    }).pipe(Effect.provide(database)))
    const staleFanout = await env.DB.prepare(
      "SELECT state FROM push_jobs WHERE event_id = 'evt_renewal_after_removal' AND subscription_id = ?"
    ).bind(id).first<{ readonly state: string }>()
    expect(staleFanout).toBeNull()

    const restored = await env.DB.prepare(
      "SELECT deleted_at, enrollment_generation FROM push_subscriptions WHERE id = ?"
    ).bind(id).first<{
      readonly deleted_at: string | null
      readonly enrollment_generation: number
    }>()
    expect(restored?.deleted_at).toBeNull()
    expect(restored?.enrollment_generation).toBe(1)
  })

  it("rejects replay after rotating the credential", async () => {
    const credential = `ops_pwa_${"e".repeat(43)}`
    await seed("sub_renewal_replay", credential, "https://push.example.test/replay-old")

    const first = await renew(
      "sub_renewal_replay",
      credential,
      "https://push.example.test/replay-new"
    )
    expect(first.status).toBe(200)

    const replay = await renew(
      "sub_renewal_replay",
      credential,
      "https://push.example.test/replay-again"
    )
    expect(replay.status).toBe(401)
    const row = await env.DB.prepare(
      "SELECT endpoint FROM push_subscriptions WHERE id = 'sub_renewal_replay'"
    ).first<{ readonly endpoint: string }>()
    expect(row?.endpoint).toBe("https://push.example.test/replay-new")
  })
})
