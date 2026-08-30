import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { deliveryTemporarilyUnavailable } from "../src/errors.js"
import {
  processDeadLetterMessage,
  processPushMessage,
  type PushJobRow
} from "../src/push.js"
import { PushDeliveryRepository } from "../src/push-repository.js"
import {
  AppConfig,
  CredentialCrypto,
  Database,
  WebPush,
  type ConfigService
} from "../src/services.js"
import { QUEUE_COMMAND_VERSION, type DeliverPushCommand } from "../src/queue-contract.js"

const message: DeliverPushCommand = {
  _tag: "DeliverPush",
  version: QUEUE_COMMAND_VERSION,
  eventId: "evt_test",
  subscriptionId: "sub_test"
}

const config = (maxPushAttempts = 6): ConfigService => ({
  baseUrl: "https://ops.example.com",
  appOrigin: "https://ops.example.com",
  appHost: "ops.example.com",
  mcpHost: "mcp.ops.example.com",
  accessAppAudience: "test-app-audience",
  accessMcpAudience: "test-mcp-audience",
  defaultRetentionDays: 0,
  maxPushAttempts,
  vapidPublicKey: "unused",
  vapidPrivateJwk: "unused",
  vapidSubject: "mailto:test@example.com"
})

const runtimeLayer = (
  response: Response | Error,
  maxPushAttempts = 6,
  onSend: () => void | Promise<void> = () => undefined
) => {
  const infrastructure = Layer.mergeAll(Database.layer(env.DB), CredentialCrypto.layer)
  const repository = PushDeliveryRepository.layer.pipe(Layer.provide(infrastructure))
  return Layer.mergeAll(
    repository,
    Layer.succeed(AppConfig)(config(maxPushAttempts)),
    Layer.succeed(WebPush)({
      send: () => Effect.tryPromise({
        try: async () => {
          await onSend()
          if (response instanceof Error) throw response
          return response
        },
        catch: (cause) => deliveryTemporarilyUnavailable(
          cause instanceof Error ? cause.message : "test delivery failed",
          cause
        )
      })
    })
  )
}

const pushRepositoryLayer = () =>
  PushDeliveryRepository.layer.pipe(
    Layer.provide(Layer.mergeAll(Database.layer(env.DB), CredentialCrypto.layer))
  )

const reset = async (): Promise<void> => {
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_push_job_insert").run()
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM push_jobs"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM push_subscriptions"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM settings")
  ])
}

const seedInfrastructure = async (): Promise<void> => {
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO projects
       (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
       VALUES ('prj_test', 'Test', 'test', '', 'hash', 1, 'info', ?, ?)`
    ).bind(now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO push_subscriptions
       (id, name, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at)
       VALUES ('sub_test', 'Test browser', 'https://push.example.test/subscription',
               'p256dh-test-key-with-enough-characters', 'auth-test-key', '', 1, ?, ?)`
    ).bind(now, now)
  ])
}

const seed = async (options: {
  readonly eventId?: string
  readonly state?: PushJobRow["state"]
  readonly attempts?: number
  readonly availableAt?: string
  readonly queuedAt?: string | null
  readonly leaseUntil?: string | null
  readonly deadAt?: string | null
} = {}): Promise<void> => {
  const now = new Date().toISOString()
  const eventId = options.eventId ?? message.eventId
  await seedInfrastructure()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO events
       (id, external_id, project_id, source, type, level, title, body, fingerprint,
        payload_json, actions_json, occurred_at, created_at, silence_id)
       VALUES (?, NULL, 'prj_test', 'test', 'test', 'error', 'Failure', 'Details',
               'fingerprint', '{}', '[]', ?, ?, NULL)`
    ).bind(eventId, now, now),
    env.DB.prepare(
      `INSERT INTO push_jobs
       (event_id, subscription_id, state, attempts, available_at, queued_at,
        lease_until, dead_at, last_error, updated_at)
       VALUES (?, 'sub_test', ?, ?, ?, ?, ?, ?, '', ?)`
    ).bind(
      eventId,
      options.state ?? "queued",
      options.attempts ?? 0,
      options.availableAt ?? new Date(Date.now() - 1_000).toISOString(),
      options.queuedAt === undefined ? now : options.queuedAt,
      options.leaseUntil ?? null,
      options.deadAt ?? null,
      now
    )
  ])
}

const getJob = async (eventId = message.eventId): Promise<PushJobRow> => {
  const row = await env.DB.prepare(
    "SELECT * FROM push_jobs WHERE event_id = ? AND subscription_id = 'sub_test'"
  ).bind(eventId).first<PushJobRow>()
  if (!row) throw new Error("missing test push job")
  return row
}

const deliveryCount = async (eventId = message.eventId): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM deliveries WHERE event_id = ?"
  ).bind(eventId).first<{ readonly count: number }>()
  return row?.count ?? 0
}

const tableCount = async (table: "events" | "push_jobs" | "deliveries"): Promise<number> => {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    readonly count: number
  }>()
  return row?.count ?? 0
}

const stateSnapshot = async (): Promise<string> => {
  const [jobs, deliveries, subscriptions] = await Promise.all([
    env.DB.prepare("SELECT * FROM push_jobs ORDER BY event_id, subscription_id").all(),
    env.DB.prepare("SELECT * FROM deliveries ORDER BY attempted_at, id").all(),
    env.DB.prepare("SELECT id, enabled FROM push_subscriptions ORDER BY id").all()
  ])
  return JSON.stringify({
    jobs: jobs.results,
    deliveries: deliveries.results,
    subscriptions: subscriptions.results
  }, null, 2)
}

describe("bounded push delivery lifecycle", () => {
  beforeEach(reset)

  it("lets only one of two racing consumers claim and deliver a job", async () => {
    await seed()
    let sends = 0
    const layer = runtimeLayer(new Response(null, { status: 201 }), 6, () => {
      sends += 1
    })

    const outcomes = await Promise.all([
      Effect.runPromise(processPushMessage(message).pipe(Effect.provide(layer))),
      Effect.runPromise(processPushMessage(message).pipe(Effect.provide(layer)))
    ])

    expect(outcomes.map((outcome) => outcome._tag).sort(), await stateSnapshot()).toEqual([
      "AlreadyProcessed",
      "Delivered"
    ])
    expect(sends, await stateSnapshot()).toBe(1)
    expect(await deliveryCount(), await stateSnapshot()).toBe(1)
  })

  it("delivers once and treats a duplicate Queue message as already processed", async () => {
    await seed()
    const layer = runtimeLayer(new Response(null, { status: 201 }))

    const first = await Effect.runPromise(processPushMessage(message).pipe(Effect.provide(layer)))
    const duplicate = await Effect.runPromise(processPushMessage(message).pipe(Effect.provide(layer)))

    expect(first._tag).toBe("Delivered")
    expect(duplicate._tag).toBe("AlreadyProcessed")
    expect((await getJob()).state).toBe("sent")
    expect(await deliveryCount()).toBe(1)
  })

  it("retries an unexpectedly early Queue delivery without claiming the job", async () => {
    await seed({ availableAt: new Date(Date.now() + 60_000).toISOString() })

    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response(null, { status: 201 })))
      )
    )

    expect(outcome._tag).toBe("Retry")
    expect((await getJob()).state).toBe("queued")
    expect((await getJob()).attempts).toBe(0)
    expect(await deliveryCount()).toBe(0)
  })

  it("reclaims an expired sending lease", async () => {
    await seed({
      state: "sending",
      attempts: 1,
      leaseUntil: new Date(Date.now() - 60_000).toISOString()
    })

    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response(null, { status: 201 })))
      )
    )

    expect(outcome._tag).toBe("Delivered")
    expect((await getJob()).attempts).toBe(2)
  })

  it("prevents an expired claimant from finalizing over the reclaimed lease", async () => {
    await seed()
    const repositoryLayer = pushRepositoryLayer()
    const firstClaim = await Effect.runPromise(
      Effect.flatMap(PushDeliveryRepository, (_) => _.claim(message)).pipe(
        Effect.provide(repositoryLayer)
      )
    )
    if (!firstClaim || "availableAt" in firstClaim) throw new Error("first claim failed")

    await env.DB.prepare(
      `UPDATE push_jobs SET lease_until = ?
       WHERE event_id = ? AND subscription_id = ?`
    ).bind(
      new Date(Date.now() - 60_000).toISOString(),
      message.eventId,
      message.subscriptionId
    ).run()

    const secondClaim = await Effect.runPromise(
      Effect.flatMap(PushDeliveryRepository, (_) => _.claim(message)).pipe(
        Effect.provide(repositoryLayer)
      )
    )
    if (!secondClaim || "availableAt" in secondClaim) throw new Error("reclaim failed")

    await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* PushDeliveryRepository
        yield* repository.finalizeSuccess(firstClaim, 201)
        yield* repository.finalizeSuccess(secondClaim, 201)
      }).pipe(Effect.provide(repositoryLayer))
    )

    expect((await getJob()).state).toBe("sent")
    expect((await getJob()).attempts).toBe(2)
    expect(await deliveryCount()).toBe(1)
  })

  it("enters the terminal dead state when the configured attempt limit is reached", async () => {
    await seed({ attempts: 1 })

    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response("temporarily unavailable", { status: 503 }), 2))
      )
    )

    const job = await getJob()
    expect(outcome._tag).toBe("PermanentFailure")
    expect(job.state).toBe("dead")
    expect(job.attempts).toBe(2)
    expect(job.dead_at).not.toBeNull()
    expect(job.last_error).toContain("delivery exhausted after 2 attempts")
    expect(await deliveryCount()).toBe(1)
  })

  it("retries a transient provider failure and records one terminal success", async () => {
    await seed()
    const first = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response("retry", { status: 503 }), 3))
      )
    )
    expect(first._tag, await stateSnapshot()).toBe("Retry")

    await env.DB.prepare(
      "UPDATE push_jobs SET available_at = ? WHERE event_id = ? AND subscription_id = ?"
    ).bind(new Date(Date.now() - 1_000).toISOString(), message.eventId, message.subscriptionId).run()

    const second = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response(null, { status: 201 }), 3))
      )
    )
    const duplicate = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response(null, { status: 201 }), 3))
      )
    )
    const deliveries = await env.DB.prepare(
      "SELECT status FROM deliveries WHERE event_id = ? ORDER BY attempted_at, id"
    ).bind(message.eventId).all<{ readonly status: string }>()

    expect(second._tag, await stateSnapshot()).toBe("Delivered")
    expect(duplicate._tag, await stateSnapshot()).toBe("AlreadyProcessed")
    expect((await getJob()).state, await stateSnapshot()).toBe("sent")
    expect(deliveries.results.map((row) => row.status), await stateSnapshot()).toEqual([
      "failed",
      "sent"
    ])
  })

  it.each([404, 410])("disables a subscription after permanent HTTP %i", async (status) => {
    await seed()
    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response("gone", { status })))
      )
    )
    const subscription = await env.DB.prepare(
      "SELECT enabled, renewal_credential_hash FROM push_subscriptions WHERE id = ?"
    ).bind(message.subscriptionId).first<{
      readonly enabled: number
      readonly renewal_credential_hash: string | null
    }>()

    expect(outcome._tag, await stateSnapshot()).toBe("PermanentFailure")
    expect((await getJob()).state, await stateSnapshot()).toBe("dead")
    expect(subscription?.enabled, await stateSnapshot()).toBe(0)
    expect(subscription?.renewal_credential_hash, await stateSnapshot()).toBeNull()
    expect(await deliveryCount(), await stateSnapshot()).toBe(1)
  })

  it("does not revoke an endpoint renewed during an in-flight delivery", async () => {
    await seed()
    const renewedEndpoint = "https://push.example.test/renewed-subscription"
    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response("gone", { status: 410 }), 6, () =>
          env.DB.prepare(
            `UPDATE push_subscriptions
             SET endpoint = ?, renewal_credential_hash = 'renewed-hash'
             WHERE id = ?`
          ).bind(renewedEndpoint, message.subscriptionId).run()
        ))
      )
    )
    const subscription = await env.DB.prepare(
      "SELECT endpoint, enabled, renewal_credential_hash FROM push_subscriptions WHERE id = ?"
    ).bind(message.subscriptionId).first<{
      readonly endpoint: string
      readonly enabled: number
      readonly renewal_credential_hash: string | null
    }>()

    expect(outcome._tag, await stateSnapshot()).toBe("PermanentFailure")
    expect(subscription).toMatchObject({
      endpoint: renewedEndpoint,
      enabled: 1,
      renewal_credential_hash: "renewed-hash"
    })
  })

  it("lets Queue own ordinary delayed retries", async () => {
    await seed()
    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response("retry", { status: 503 }), 4))
      )
    )
    expect(outcome._tag).toBe("Retry")

    const job = await getJob()
    expect(job.state).toBe("retrying")
    expect(job.available_at > new Date().toISOString()).toBe(true)
  })

  it("cascades event deletion to push jobs and delivery history", async () => {
    await seed()
    await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response(null, { status: 201 })))
      )
    )
    await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(message.eventId).run()

    expect(await tableCount("events"), await stateSnapshot()).toBe(0)
    expect(await tableCount("push_jobs"), await stateSnapshot()).toBe(0)
    expect(await tableCount("deliveries"), await stateSnapshot()).toBe(0)
  })

  it("records a terminal outcome when infrastructure sends a message to the DLQ", async () => {
    await seed()

    const outcome = await Effect.runPromise(
      processDeadLetterMessage(message).pipe(
        Effect.provide(pushRepositoryLayer())
      )
    )

    const job = await getJob()
    expect(outcome._tag).toBe("PermanentFailure")
    expect(job.state).toBe("dead")
    expect(job.last_error).toContain("dead-letter queue")
    expect(await deliveryCount()).toBe(1)
  })
})
