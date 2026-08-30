import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import {
  D1RepositoriesLive,
  EventsRepository,
  ProjectsRepository
} from "../src/repositories.js"

const reset = async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM push_jobs"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM projects")
  ])
}

const seedProject = async (): Promise<void> => {
  const now = new Date(0).toISOString()
  await env.DB.prepare(`INSERT INTO projects
    (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
    VALUES ('prj_decode', 'Decode', 'decode', '', 'decode-hash', 1, 'info', ?, ?)`)
    .bind(now, now).run()
}

describe("D1 repository row decoding", () => {
  beforeEach(async () => {
    await reset()
    await seedProject()
  })

  it("rejects malformed stored JSON at the repository boundary", async () => {
    const now = new Date(0).toISOString()
    await env.DB.prepare(`INSERT INTO events
      (id, external_id, project_id, source, type, level, title, body, fingerprint,
       payload_json, actions_json, occurred_at, created_at, silence_id)
      VALUES ('evt_bad_json', NULL, 'prj_decode', '', '', 'info', 'Bad JSON', '', '',
              '{not-json', '[]', ?, ?, NULL)`).bind(now, now).run()

    const result = await Effect.runPromiseExit(
      Effect.gen(function*() {
        return yield* (yield* EventsRepository).findById("evt_bad_json")
      }).pipe(Effect.provide(D1RepositoriesLive(env.DB)))
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("repository read failed")
      expect(String(result.cause)).not.toContain("{not-json")
    }
  })

  it("rejects a row whose runtime shape has drifted from the migration contract", async () => {
    await env.DB.prepare("PRAGMA ignore_check_constraints = ON").run()
    await env.DB.prepare("UPDATE projects SET notify = 'enabled' WHERE id = 'prj_decode'").run()

    const result = await Effect.runPromiseExit(
      Effect.gen(function*() {
        return yield* (yield* ProjectsRepository).findById("prj_decode")
      }).pipe(Effect.provide(D1RepositoriesLive(env.DB)))
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("repository read failed")
      expect(String(result.cause)).not.toContain("enabled")
    }
  })
})
