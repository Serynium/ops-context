import { env } from "cloudflare:workers"
import { Effect, Layer, Result } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import {
  enqueueEventForProject,
  processIngestEvent
} from "../src/events.js"
import { queueUnavailable } from "../src/errors.js"
import {
  QUEUE_COMMAND_VERSION,
  type IngestEventCommand,
  type QueueCommand
} from "../src/queue-contract.js"
import {
  AppConfig,
  CredentialCrypto,
  Database,
  PushQueue,
  type ConfigService
} from "../src/services.js"
import type { ProjectRow } from "../src/types.js"

const config: ConfigService = {
  baseUrl: "https://ops.example.com",
  appOrigin: "https://ops.example.com",
  appHost: "ops.example.com",
  defaultRetentionDays: 90,
  maxPushAttempts: 6,
  vapidPublicKey: "unused",
  vapidPrivateJwk: "unused",
  vapidSubject: "mailto:test@example.com"
}

const project: ProjectRow = {
  id: "prj_ingest",
  name: "Ingest",
  slug: "ingest",
  icon: "",
  api_key_hash: "hash",
  notify: 1,
  min_level: "info",
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString()
}

const command = (eventId = "evt_ingest"): IngestEventCommand => ({
  _tag: "IngestEvent",
  version: QUEUE_COMMAND_VERSION,
  eventId,
  projectId: project.id,
  acceptedAt: "2026-08-31T00:00:00.000Z",
  event: {
    external_id: "source-42",
    title: "Queue first",
    body: "Persisted by the consumer",
    level: "error",
    data: { token: "redact-me" }
  }
})

const reset = async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM push_jobs"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM push_subscriptions"),
    env.DB.prepare("DELETE FROM settings")
  ])
  await env.DB.prepare(
    `INSERT INTO projects
     (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    project.id,
    project.name,
    project.slug,
    project.icon,
    project.api_key_hash,
    project.notify,
    project.min_level,
    project.created_at,
    project.updated_at
  ).run()
  const now = new Date(0).toISOString()
  for (const id of ["sub_a", "sub_b", "sub_c"]) {
    await env.DB.prepare(
      `INSERT INTO push_subscriptions
       (id, name, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'p256dh', 'auth', '', 1, ?, ?)`
    ).bind(id, id, `https://push.example.test/${id}`, now, now).run()
  }
}

const ingestionLayer = (
  send: (message: QueueCommand) => Effect.Effect<void, ReturnType<typeof queueUnavailable>>
) => Layer.mergeAll(
  Database.layer(env.DB),
  Layer.succeed(AppConfig)(config),
  Layer.succeed(PushQueue)({
    send,
    sendMany: (messages) => Effect.forEach(messages, send, { discard: true })
  })
)

describe("Queue-first event ingestion", () => {
  beforeEach(reset)

  it("returns a retryable failure when the acceptance Queue send fails", async () => {
    const layer = Layer.mergeAll(
      Database.layer(env.DB),
      CredentialCrypto.layer,
      Layer.succeed(PushQueue)({
        send: () => Effect.fail(queueUnavailable("Queue unavailable")),
        sendMany: () => Effect.fail(queueUnavailable("Queue unavailable"))
      })
    )
    const result = await Effect.runPromise(
      enqueueEventForProject(project, { title: "Not accepted" }).pipe(
        Effect.provide(layer),
        Effect.result
      )
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.status).toBe(503)
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>()
    expect(rows?.count).toBe(0)
  })

  it("persists duplicate ingest delivery once and publishes one job per subscription", async () => {
    const published: QueueCommand[] = []
    const layer = ingestionLayer((message) => Effect.sync(() => published.push(message)).pipe(Effect.asVoid))

    await Effect.runPromise(processIngestEvent(command()).pipe(Effect.provide(layer)))
    await Effect.runPromise(processIngestEvent(command()).pipe(Effect.provide(layer)))

    const events = await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>()
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM push_jobs").first<{ count: number }>()
    expect(events?.count).toBe(1)
    expect(jobs?.count).toBe(3)
    expect(published).toHaveLength(3)
    expect(published.every((entry) => entry._tag === "DeliverPush")).toBe(true)
  })

  it("recovers a consumer failure after D1 commit without retention or repair Cron", async () => {
    let calls = 0
    const firstLayer = ingestionLayer((message) => {
      calls++
      return calls === 2
        ? Effect.fail(queueUnavailable("simulated partial fan-out failure"))
        : Effect.void
    })
    const first = await Effect.runPromise(
      processIngestEvent(command()).pipe(Effect.provide(firstLayer), Effect.result)
    )
    expect(Result.isFailure(first)).toBe(true)

    const afterCrash = await env.DB.prepare(
      "SELECT state, COUNT(*) AS count FROM push_jobs GROUP BY state ORDER BY state"
    ).all<{ state: string; count: number }>()
    expect(afterCrash.results).toEqual([
      { state: "pending", count: 2 },
      { state: "queued", count: 1 }
    ])

    const recovered: QueueCommand[] = []
    await Effect.runPromise(
      processIngestEvent(command()).pipe(
        Effect.provide(ingestionLayer((message) =>
          Effect.sync(() => recovered.push(message)).pipe(Effect.asVoid)
        ))
      )
    )
    expect(recovered).toHaveLength(2)
    const finalJobs = await env.DB.prepare(
      "SELECT state, COUNT(*) AS count FROM push_jobs GROUP BY state"
    ).all<{ state: string; count: number }>()
    expect(finalJobs.results).toEqual([{ state: "queued", count: 3 }])
  })

  it("keeps external_id stable across producer retries and contains no reusable credentials", async () => {
    const accepted: QueueCommand[] = []
    const layer = Layer.mergeAll(
      Database.layer(env.DB),
      CredentialCrypto.layer,
      Layer.succeed(PushQueue)({
        send: (message) => Effect.sync(() => accepted.push(message)).pipe(Effect.asVoid),
        sendMany: () => Effect.void
      })
    )
    const input = { title: "Producer retry", external_id: "same-operation" }
    const first = await Effect.runPromise(enqueueEventForProject(project, input).pipe(Effect.provide(layer)))
    const second = await Effect.runPromise(enqueueEventForProject(project, input).pipe(Effect.provide(layer)))

    expect(first.id).toBe(second.id)
    expect(accepted).toHaveLength(2)
    const encoded = JSON.stringify(accepted)
    expect(encoded).not.toContain("api_key")
    expect(encoded).not.toContain("authorization")
    expect(encoded).not.toContain(project.api_key_hash)
  })
})
