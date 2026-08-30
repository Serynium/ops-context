import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { createEventForProject } from "../src/events.js"
import { internal } from "../src/errors.js"
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
import type { ProjectRow, PushJobMessage } from "../src/types.js"

const message: PushJobMessage = {
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
  onSend: () => void = () => undefined
) => Layer.mergeAll(
  Database.layer(env.DB),
  CredentialCrypto.layer,
  Layer.succeed(AppConfig)(config(maxPushAttempts)),
  Layer.succeed(WebPush)({
    send: () => Effect.sync(onSend).pipe(
      Effect.flatMap(() => response instanceof Error
        ? Effect.fail(internal(response.message, response))
        : Effect.succeed(response))
    )
  })
)

const project: ProjectRow = {
  id: "prj_test",
  name: "Test",
  slug: "test",
  icon: "",
  api_key_hash: "hash",
  notify: 1,
  min_level: "info",
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString()
}

const queueLayer = (
  published: PushJobMessage[],
  failPublication = false
) => Layer.succeed(PushQueue)({
  send: (item) => failPublication
    ? Effect.fail(internal("test Queue publication failed"))
    : Effect.sync(() => published.push(item)).pipe(Effect.asVoid),
  sendMany: (items) => failPublication
    ? Effect.fail(internal("test Queue publication failed"))
    : Effect.sync(() => published.push(...items)).pipe(Effect.asVoid)
})

const eventLayer = (
  published: PushJobMessage[],
  failPublication = false
) => Layer.mergeAll(
  Database.layer(env.DB),
  CredentialCrypto.layer,
  Layer.succeed(AppConfig)(config()),
  queueLayer(published, failPublication)
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
      "SELECT enabled FROM push_subscriptions WHERE id = ?"
    ).bind(message.subscriptionId).first<{ readonly enabled: number }>()

    expect(outcome._tag, await stateSnapshot()).toBe("PermanentFailure")
    expect((await getJob()).state, await stateSnapshot()).toBe("dead")
    expect(subscription?.enabled, await stateSnapshot()).toBe(0)
    expect(await deliveryCount(), await stateSnapshot()).toBe(1)
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

  it("recovers a Queue publication lost after the event and job commit", async () => {
    await seedInfrastructure()
    const dropped: PushJobMessage[] = []
    const created = await Effect.runPromise(
      createEventForProject(project, {
        external_id: "lost-publication",
        level: "error",
        title: "Committed before Queue publication"
      }).pipe(Effect.provide(eventLayer(dropped, true)))
    )

    expect(dropped).toEqual([])
    expect((await getJob(created.id)).state, await stateSnapshot()).toBe("pending")

    const recovered: PushJobMessage[] = []
    const maintenanceLayer = Layer.mergeAll(
      Database.layer(env.DB),
      Layer.succeed(AppConfig)(config()),
      queueLayer(recovered)
    )
    const result = await Effect.runPromise(runMaintenance.pipe(Effect.provide(maintenanceLayer)))

    expect(result.recoveredJobs, await stateSnapshot()).toBe(1)
    expect(recovered).toEqual([{ eventId: created.id, subscriptionId: "sub_test" }])
    expect((await getJob(created.id)).state, await stateSnapshot()).toBe("queued")
  })

  it("creates an event and all of its push jobs atomically", async () => {
    await seedInfrastructure()
    await env.DB.prepare(
      `CREATE TRIGGER fail_push_job_insert
       BEFORE INSERT ON push_jobs
       BEGIN
         SELECT RAISE(ABORT, 'forced push-job insert failure');
       END`
    ).run()

    const published: PushJobMessage[] = []
    await expect(Effect.runPromise(
      createEventForProject(project, {
        external_id: "atomic-event",
        level: "error",
        title: "Must roll back"
      }).pipe(Effect.provide(eventLayer(published)))
    )).rejects.toBeDefined()

    expect(await tableCount("events"), await stateSnapshot()).toBe(0)
    expect(await tableCount("push_jobs"), await stateSnapshot()).toBe(0)
    expect(published).toEqual([])
  })

  it("treats duplicate external_id ingestion as one event and one job", async () => {
    await seedInfrastructure()
    const published: PushJobMessage[] = []
    const layer = eventLayer(published)
    const input = {
      external_id: "provider-event-42",
      level: "error" as const,
      title: "Original title"
    }

    const first = await Effect.runPromise(
      createEventForProject(project, input).pipe(Effect.provide(layer))
    )
    const duplicate = await Effect.runPromise(
      createEventForProject(project, { ...input, title: "Duplicate title" }).pipe(Effect.provide(layer))
    )

    expect(duplicate.id).toBe(first.id)
    expect(duplicate.title).toBe("Original title")
    expect(await tableCount("events"), await stateSnapshot()).toBe(1)
    expect(await tableCount("push_jobs"), await stateSnapshot()).toBe(1)
    expect(published).toEqual([{ eventId: first.id, subscriptionId: "sub_test" }])
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
