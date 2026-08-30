import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import worker from "../src/index.js"
import { CredentialCrypto, Database } from "../src/services.js"
import { registerSubscription, updateSubscription } from "../src/subscriptions.js"

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
) as Parameters<typeof worker.fetch>[0], env)

describe.sequential("installation-scoped push renewal credentials", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE id LIKE 'sub_renewal_%'").run()
  })

  it("returns a one-time credential at enrollment while storing only its hash", async () => {
    const result = await Effect.runPromise(
      registerSubscription(
        { name: "Enrollment", subscription: subscription("https://push.example.test/enrollment") },
        "test agent"
      ).pipe(Effect.provide(Layer.mergeAll(Database.layer(env.DB), CredentialCrypto.layer)))
    )

    expect(result.renewal_credential).toMatch(/^ops_pwa_[A-Za-z0-9_-]{40,}$/u)
    const row = await env.DB.prepare(
      "SELECT renewal_credential_hash FROM push_subscriptions WHERE id = ?"
    ).bind(result.subscription.id).first<{ readonly renewal_credential_hash: string }>()
    expect(row?.renewal_credential_hash).toBe(await sha256Hex(result.renewal_credential))
    expect(JSON.stringify(row)).not.toContain(result.renewal_credential)
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

  it("rejects a credential belonging to a disabled installation", async () => {
    const credential = `ops_pwa_${"d".repeat(43)}`
    await seed("sub_renewal_revoked", credential, "https://push.example.test/revoked", false)

    const response = await renew(
      "sub_renewal_revoked",
      credential,
      "https://push.example.test/revoked-new"
    )
    expect(response.status).toBe(401)
  })

  it("requires re-enrollment instead of enabling a row with a revoked credential", async () => {
    const credential = `ops_pwa_${"f".repeat(43)}`
    await seed("sub_renewal_reenable", credential, "https://push.example.test/reenable")
    const database = Database.layer(env.DB)

    await Effect.runPromise(updateSubscription("sub_renewal_reenable", { enabled: false }).pipe(
      Effect.provide(database)
    ))
    await expect(Effect.runPromise(updateSubscription("sub_renewal_reenable", { enabled: true }).pipe(
      Effect.provide(database)
    ))).rejects.toMatchObject({ status: 422 })

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
