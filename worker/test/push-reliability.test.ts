import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { deliveryTemporarilyUnavailable } from "../src/errors.js"
import { runMaintenance } from "../src/maintenance.js"
import {
  processDeadLetterMessage,
  processPushMessage,
  type PushJobRow
} from "../src/push.js"
import {
  AppConfig,
  CredentialCrypto,
  Database,
  PushQueue,
  WebPush,
  type ConfigService
} from "../src/services.js"
import type { PushJobMessage } from "../src/types.js"

const message: PushJobMessage = {
  eventId: "evt_test",
  subscriptionId: "sub_test"
}

const config = (maxPushAttempts = 6): ConfigService => ({
  baseUrl: "https://ops.example.com",
  appOrigin: "https://ops.example.com",
  appHost: "ops.example.com",
  defaultRetentionDays: 0,
  maxPushAttempts,
  vapidPublicKey: "unused",
  vapidPrivateJwk: "unused",
  vapidSubject: "mailto:test@example.com"
})

const runtimeLayer = (
  response: Response | Error,
  maxPushAttempts = 6
) => Layer.mergeAll(
  Database.layer(env.DB),
  CredentialCrypto.layer,
  Layer.succeed(AppConfig)(config(maxPushAttempts)),
  Layer.succeed(WebPush)({
    send: () => response instanceof Error
      ? Effect.fail(deliveryTemporarilyUnavailable(response.message, response))
      : Effect.succeed(response)
  })
)

const reset = async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM push_jobs"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM push_subscriptions"),
    env.DB.prepare("DELETE FROM settings")
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
    ).bind(now, now),
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

describe("bounded push delivery lifecycle", () => {
  beforeEach(reset)

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

  it("lets Queue own ordinary delayed retries instead of immediate Cron republication", async () => {
    await seed()
    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(runtimeLayer(new Response("retry", { status: 503 }), 4))
      )
    )
    expect(outcome._tag).toBe("Retry")

    await env.DB.prepare(
      "UPDATE push_jobs SET available_at = ? WHERE event_id = ? AND subscription_id = ?"
    ).bind(new Date(Date.now() - 1_000).toISOString(), message.eventId, message.subscriptionId).run()

    const published: PushJobMessage[] = []
    const maintenanceLayer = Layer.mergeAll(
      Database.layer(env.DB),
      Layer.succeed(AppConfig)(config()),
      Layer.succeed(PushQueue)({
        send: (item) => Effect.sync(() => published.push(item)).pipe(Effect.asVoid),
        sendMany: (items) => Effect.sync(() => published.push(...items)).pipe(Effect.asVoid)
      })
    )
    const result = await Effect.runPromise(runMaintenance.pipe(Effect.provide(maintenanceLayer)))

    expect(result.recoveredJobs).toBe(0)
    expect(published).toEqual([])
    expect((await getJob()).state).toBe("retrying")
  })

  it("recovers an unpublished job while never resurrecting a dead job", async () => {
    await seed({ state: "pending", queuedAt: null })
    await seed({
      eventId: "evt_dead",
      state: "dead",
      attempts: 6,
      deadAt: new Date().toISOString()
    })

    const published: PushJobMessage[] = []
    const maintenanceLayer = Layer.mergeAll(
      Database.layer(env.DB),
      Layer.succeed(AppConfig)(config()),
      Layer.succeed(PushQueue)({
        send: (item) => Effect.sync(() => published.push(item)).pipe(Effect.asVoid),
        sendMany: (items) => Effect.sync(() => published.push(...items)).pipe(Effect.asVoid)
      })
    )
    const result = await Effect.runPromise(runMaintenance.pipe(Effect.provide(maintenanceLayer)))

    expect(result.recoveredJobs).toBe(1)
    expect(published).toEqual([message])
    expect((await getJob()).state).toBe("queued")
    expect((await getJob("evt_dead")).state).toBe("dead")
  })

  it("records a terminal outcome when infrastructure sends a message to the DLQ", async () => {
    await seed()

    const outcome = await Effect.runPromise(
      processDeadLetterMessage(message).pipe(
        Effect.provide(Layer.mergeAll(Database.layer(env.DB), CredentialCrypto.layer))
      )
    )

    const job = await getJob()
    expect(outcome._tag).toBe("PermanentFailure")
    expect(job.state).toBe("dead")
    expect(job.last_error).toContain("dead-letter queue")
    expect(await deliveryCount()).toBe(1)
  })
})
