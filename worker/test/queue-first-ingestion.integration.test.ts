import { env } from "cloudflare:workers"
import { Effect, Layer, Result } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import {
  enqueueEventForProject,
  getEvent,
  processIngestDeadLetter,
  processIngestEvent,
  unsilenceEvent
} from "../src/events.js"
import { queueUnavailable, repositoryUnavailable } from "../src/errors.js"
import {
  encodedQueueCommandBytes,
  QUEUE_COMMAND_MAX_BYTES,
  QUEUE_COMMAND_VERSION,
  decodeQueueCommand,
  type IngestEventCommand,
  type QueueCommand
} from "../src/queue-contract.js"
import { D1RepositoriesLive, EventsRepository } from "../src/repositories.js"
import {
  AppConfig,
  CredentialCrypto,
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
    env.DB.prepare("DELETE FROM ingestion_failures"),
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
  D1RepositoriesLive(env.DB),
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
      D1RepositoriesLive(env.DB),
      Layer.succeed(AppConfig)(config),
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
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("QueueUnavailable")
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>()
    expect(rows?.count).toBe(0)
  })

  it("accepts deterministic external IDs when the compatibility D1 read is unavailable", async () => {
    const legacyCreatedAt = new Date(0).toISOString()
    await env.DB.prepare(
      `INSERT INTO events
       (id, external_id, project_id, source, type, level, title, body, fingerprint,
        payload_json, actions_json, occurred_at, created_at, silence_id, fanout_completed_at)
       VALUES ('evt_legacy_random', 'stable-during-outage', ?, '', '', 'info',
               'Legacy event', '', '', '{}', '[]', ?, ?, NULL, ?)`
    ).bind(project.id, legacyCreatedAt, legacyCreatedAt, legacyCreatedAt).run()

    const liveEvents = await Effect.runPromise(EventsRepository.pipe(
      Effect.provide(D1RepositoriesLive(env.DB))
    ))
    const failedEvents = EventsRepository.of({
      ...liveEvents,
      findIdByExternalId: () => Effect.fail(repositoryUnavailable("simulated D1 outage"))
    })
    const accepted: QueueCommand[] = []
    const layer = Layer.mergeAll(
      D1RepositoriesLive(env.DB),
      Layer.succeed(EventsRepository)(failedEvents),
      Layer.succeed(AppConfig)(config),
      CredentialCrypto.layer,
      Layer.succeed(PushQueue)({
        send: (message) => Effect.sync(() => accepted.push(message)).pipe(Effect.asVoid),
        sendMany: () => Effect.void
      })
    )

    const first = await Effect.runPromise(enqueueEventForProject(project, {
      title: "D1-independent acceptance",
      external_id: "stable-during-outage"
    }).pipe(Effect.provide(layer)))
    const second = await Effect.runPromise(enqueueEventForProject(project, {
      title: "D1-independent acceptance",
      external_id: "stable-during-outage"
    }).pipe(Effect.provide(layer)))

    expect(first.id).toBe(second.id)
    expect(first.status).toBe("queued")
    expect(accepted).toHaveLength(2)

    const acceptedCommand = accepted[0]
    expect(acceptedCommand?._tag).toBe("IngestEvent")
    if (acceptedCommand?._tag !== "IngestEvent") throw new Error("missing ingestion command")
    await Effect.runPromise(processIngestEvent(acceptedCommand).pipe(
      Effect.provide(ingestionLayer(() => Effect.void))
    ))
    const resolved = await Effect.runPromise(getEvent(first.id).pipe(
      Effect.provide(D1RepositoriesLive(env.DB))
    ))
    expect(resolved.id).toBe("evt_legacy_random")
  })

  it("persists duplicate ingest delivery once and publishes one job per subscription", async () => {
    const published: QueueCommand[] = []
    const layer = ingestionLayer((message) => Effect.sync(() => published.push(message)).pipe(Effect.asVoid))

    await Effect.runPromise(processIngestEvent(command()).pipe(Effect.provide(layer)))
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO push_subscriptions
       (id, name, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at)
       VALUES ('sub_later', 'Later', 'https://push.example.test/later', 'p256dh', 'auth', '', 1, ?, ?)`
    ).bind(now, now).run()
    await Effect.runPromise(processIngestEvent(command()).pipe(Effect.provide(layer)))

    const events = await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>()
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM push_jobs").first<{ count: number }>()
    expect(events?.count).toBe(1)
    expect(jobs?.count).toBe(3)
    expect(published).toHaveLength(3)
    expect(published.every((entry) => entry._tag === "DeliverPush")).toBe(true)
  })

  it("decodes delivery commands produced by the pre-versioned rollout", async () => {
    const decoded = await Effect.runPromise(decodeQueueCommand({
      eventId: "evt_legacy",
      subscriptionId: "sub_legacy"
    }))
    expect(decoded).toEqual({
      _tag: "DeliverPush",
      version: QUEUE_COMMAND_VERSION,
      eventId: "evt_legacy",
      subscriptionId: "sub_legacy"
    })
  })

  it("rejects tagged delivery commands with an unsupported version", async () => {
    const result = await Effect.runPromise(decodeQueueCommand({
      _tag: "DeliverPush",
      version: 2,
      eventId: "evt_future",
      subscriptionId: "sub_future"
    }).pipe(Effect.result))

    expect(Result.isFailure(result)).toBe(true)
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
      D1RepositoriesLive(env.DB),
      Layer.succeed(AppConfig)(config),
      CredentialCrypto.layer,
      Layer.succeed(PushQueue)({
        send: (message) => Effect.sync(() => accepted.push(message)).pipe(Effect.asVoid),
        sendMany: () => Effect.void
      })
    )
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('redact_keys', '[\"deployment_secret\"]', ?)"
    ).bind(new Date().toISOString()).run()
    const input = {
      title: "Producer retry",
      external_id: "same-operation",
      data: {
        authorization: "Bearer reusable-default-secret",
        nested: { deployment_secret: "reusable-operator-secret", safe: "visible" }
      }
    }
    const first = await Effect.runPromise(enqueueEventForProject(project, input).pipe(Effect.provide(layer)))
    const second = await Effect.runPromise(enqueueEventForProject(project, input).pipe(Effect.provide(layer)))

    expect(first.id).toBe(second.id)
    expect(accepted).toHaveLength(2)
    const encoded = JSON.stringify(accepted)
    expect(encoded).not.toContain("api_key")
    expect(encoded).not.toContain("reusable-default-secret")
    expect(encoded).not.toContain("reusable-operator-secret")
    expect(encoded).toContain("[REDACTED]")
    expect(encoded).toContain("visible")
    expect(encoded).not.toContain(project.api_key_hash)
  })

  it("keeps the complete ingestion command below the Queue message ceiling", async () => {
    const accepted: QueueCommand[] = []
    const layer = Layer.mergeAll(
      D1RepositoriesLive(env.DB),
      Layer.succeed(AppConfig)(config),
      CredentialCrypto.layer,
      Layer.succeed(PushQueue)({
        send: (message) => Effect.sync(() => accepted.push(message)).pipe(Effect.asVoid),
        sendMany: () => Effect.void
      })
    )

    await Effect.runPromise(enqueueEventForProject(project, {
      title: "Largest durable event",
      data: { context: "x".repeat(119_000) }
    }).pipe(Effect.provide(layer)))

    expect(accepted).toHaveLength(1)
    expect(encodedQueueCommandBytes(accepted[0]!)).toBeLessThanOrEqual(QUEUE_COMMAND_MAX_BYTES)
  })

  it("records an operator-visible terminal outcome when ingestion reaches the DLQ", async () => {
    const failed = ingestionLayer(() => Effect.fail(queueUnavailable("downstream Queue unavailable")))
    await Effect.runPromise(processIngestDeadLetter(command()).pipe(Effect.provide(failed)))

    const failure = await env.DB.prepare(
      "SELECT error FROM ingestion_failures WHERE event_id = ?"
    ).bind(command().eventId).first<{ error: string }>()
    expect(failure?.error).toContain("downstream Queue unavailable")
    const states = await env.DB.prepare(
      "SELECT state, COUNT(*) AS count FROM push_jobs GROUP BY state"
    ).all<{ state: string; count: number }>()
    expect(states.results).toEqual([{ state: "dead", count: 3 }])
  })

  it("retries pending unsilence fan-out after a Queue publication failure", async () => {
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO silences (id, project_id, field, value, note, created_at)
       VALUES ('sil_test', ?, 'fingerprint', 'silenced', '', ?)`
    ).bind(project.id, now).run()
    await env.DB.prepare(
      `INSERT INTO events
       (id, external_id, project_id, source, type, level, title, body, fingerprint,
        payload_json, actions_json, occurred_at, created_at, silence_id, fanout_completed_at)
       VALUES ('evt_silenced', NULL, ?, '', '', 'info', 'Silenced', '', 'silenced',
               '{}', '[]', ?, ?, 'sil_test', ?)`
    ).bind(project.id, now, now, now).run()

    const first = await Effect.runPromise(
      unsilenceEvent("evt_silenced").pipe(
        Effect.provide(ingestionLayer(() => Effect.fail(queueUnavailable("Queue unavailable")))),
        Effect.result
      )
    )
    expect(Result.isFailure(first)).toBe(true)

    const published: QueueCommand[] = []
    await Effect.runPromise(unsilenceEvent("evt_silenced").pipe(
      Effect.provide(ingestionLayer((message) =>
        Effect.sync(() => published.push(message)).pipe(Effect.asVoid)
      ))
    ))
    expect(published).toHaveLength(3)
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM push_jobs WHERE event_id = 'evt_silenced' AND state = 'pending'"
    ).first<{ count: number }>()
    expect(pending?.count).toBe(0)
  })
})
