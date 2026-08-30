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
    const result = await Effect.runPromise(runRetention.pipe(Effect.provide(
      Layer.mergeAll(D1RepositoriesLive(env.DB), Layer.succeed(AppConfig)(config))
    )))
    expect(result).toEqual({ prunedEvents: 1 })
    const ids = await env.DB.prepare("SELECT id FROM events ORDER BY id").all<{ id: string }>()
    expect(ids.results).toEqual([{ id: "evt_current" }])
  })
})
