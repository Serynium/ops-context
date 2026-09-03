import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { runRetention } from "../src/retention.js"
import { D1RepositoriesLive } from "../src/repositories.js"
import { AppConfig, type ConfigService } from "../src/services.js"

const config: ConfigService = {
  baseUrl: "https://ops.example.com",
  appOrigin: "https://ops.example.com",
  appHost: "ops.example.com",
  defaultRetentionDays: 1,
  maxPushAttempts: 6,
  vapidPublicKey: "unused",
  vapidPrivateJwk: "unused",
  vapidSubject: "mailto:test@example.com"
}

const layer = () =>
  Layer.mergeAll(
    D1RepositoriesLive(env.DB),
    Layer.succeed(AppConfig)(config)
  )

describe("scheduled retention", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deliveries"),
      env.DB.prepare("DELETE FROM push_jobs"),
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM projects"),
      env.DB.prepare("DELETE FROM settings")
    ])
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO projects
       (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
       VALUES ('prj_retention', 'Retention', 'retention', '', 'hash', 0, 'info', ?, ?)`
    ).bind(now, now).run()
    for (const [id, createdAt] of [
      ["evt_old", "2020-01-01T00:00:00.000Z"],
      ["evt_current", now]
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO events
         (id, external_id, project_id, source, type, level, title, body, fingerprint,
          payload_json, actions_json, occurred_at, created_at, silence_id)
         VALUES (?, NULL, 'prj_retention', '', '', 'info', ?, '', '', '{}', '[]', ?, ?, NULL)`
      ).bind(id, id, createdAt, createdAt).run()
    }
  })

  it("prunes only expired events without any Queue dependency", async () => {
    const result = await Effect.runPromise(
      runRetention.pipe(Effect.provide(layer()))
    )
    expect(result).toEqual({
      prunedEvents: 1,
      prunedPushJobs: 0,
      prunedDeliveries: 0,
      batches: 1,
      pushJobBatches: 0,
      deliveryBatches: 0,
      continuationRequired: false
    })
    const ids = await env.DB.prepare("SELECT id FROM events ORDER BY id").all<{ id: string }>()
    expect(ids.results).toEqual([{ id: "evt_current" }])
  })

  it("uses bounded statements and continues across multiple batches", async () => {
    const old = "2020-01-01T00:00:00.000Z"
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 500
       )
       INSERT INTO events
       (id, external_id, project_id, source, type, level, title, body, fingerprint,
        payload_json, actions_json, occurred_at, created_at, silence_id)
       SELECT
         'evt_batch_' || value,
         NULL,
         'prj_retention',
         '',
         '',
         'info',
         'Batch ' || value,
         '',
         '',
         '{}',
         '[]',
         ?,
         ?,
         NULL
       FROM sequence`
    ).bind(old, old).run()

    const result = await Effect.runPromise(
      runRetention.pipe(Effect.provide(layer()))
    )
    expect(result).toEqual({
      prunedEvents: 501,
      prunedPushJobs: 0,
      prunedDeliveries: 0,
      batches: 2,
      pushJobBatches: 0,
      deliveryBatches: 0,
      continuationRequired: false
    })
    const ids = await env.DB.prepare("SELECT id FROM events ORDER BY id").all<{ id: string }>()
    expect(ids.results).toEqual([{ id: "evt_current" }])
  })

  it("prunes old terminal push jobs without touching active or recent jobs", async () => {
    const old = "2020-01-01T00:00:00.000Z"
    const now = new Date().toISOString()
    const subscriptions = ["sent_old", "dead_old", "retrying_old", "sent_current"] as const
    const statement = env.DB.prepare(
      `INSERT INTO push_subscriptions
       (id, name, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'p256dh', 'auth', '', 1, ?, ?)`
    )
    await env.DB.batch(subscriptions.map((id) => statement.bind(
      `sub_${id}`, id, `https://push.example/${id}`, now, now
    )))
    await env.DB.batch([
      ["sub_sent_old", "sent", old, null],
      ["sub_dead_old", "dead", old, old],
      ["sub_retrying_old", "retrying", old, null],
      ["sub_sent_current", "sent", now, null]
    ].map(([subscriptionId, state, updatedAt, deadAt]) => env.DB.prepare(
      `INSERT INTO push_jobs
       (event_id, subscription_id, state, attempts, available_at, queued_at,
        lease_until, dead_at, last_error, updated_at)
       VALUES ('evt_current', ?, ?, 1, ?, NULL, NULL, ?, '', ?)`
    ).bind(subscriptionId, state, updatedAt, deadAt, updatedAt)))

    const result = await Effect.runPromise(runRetention.pipe(Effect.provide(layer())))
    expect(result).toEqual({
      prunedEvents: 1,
      prunedPushJobs: 2,
      prunedDeliveries: 0,
      batches: 1,
      pushJobBatches: 1,
      deliveryBatches: 0,
      continuationRequired: false
    })
    const jobs = await env.DB.prepare(
      "SELECT state FROM push_jobs ORDER BY state"
    ).all<{ state: string }>()
    expect(jobs.results).toEqual([{ state: "retrying" }, { state: "sent" }])
  })

  it("prunes successful delivery history for old events but retains failures", async () => {
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('retention_days', '0', ?)"
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO push_subscriptions
         (id, name, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at)
         VALUES ('sub_retention', 'Retention', 'https://push.example/retention',
                 'p256dh', 'auth', '', 1, ?, ?)`
      ).bind(now, now)
    ])
    await env.DB.batch([
      ["evt_old", "sent"],
      ["evt_old", "failed"],
      ["evt_current", "sent"]
    ].map(([eventId, status]) => env.DB.prepare(
      `INSERT INTO deliveries
       (event_id, subscription_id, status, response_status, error, attempted_at, created_at)
       VALUES (?, 'sub_retention', ?, 201, '', ?, ?)`
    ).bind(eventId, status, now, now)))

    const result = await Effect.runPromise(runRetention.pipe(Effect.provide(layer())))
    expect(result).toMatchObject({
      prunedEvents: 0,
      prunedDeliveries: 1,
      deliveryBatches: 1,
      continuationRequired: false
    })
    const rows = await env.DB.prepare(
      "SELECT event_id, status FROM deliveries ORDER BY event_id, status"
    ).all<{ event_id: string; status: string }>()
    expect(rows.results).toEqual([
      { event_id: "evt_current", status: "sent" },
      { event_id: "evt_old", status: "failed" }
    ])
  })
})
