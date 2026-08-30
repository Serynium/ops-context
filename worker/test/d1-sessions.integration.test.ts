import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import {
  D1RepositoriesLive,
  EventsRepository,
  ProjectsRepository,
  type EventInsert
} from "../src/repositories.js"

const reset = async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM push_jobs"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM projects")
  ])
}

const runSession = <A>(
  session: D1DatabaseSession,
  effect: Effect.Effect<A, unknown, EventsRepository | ProjectsRepository>
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(D1RepositoriesLive(session))))

const event = (id: string, createdAt: string, fingerprint = "session-group"): EventInsert => ({
  id,
  externalId: null,
  projectId: "prj_session",
  source: "session-test",
  type: "fixture",
  level: "info",
  title: id,
  body: "",
  fingerprint,
  payloadJson: "{}",
  actionsJson: "[]",
  occurredAt: createdAt,
  createdAt,
  silenceId: null
})

describe("D1 Sessions repository prototype", () => {
  beforeEach(reset)

  it("reads its own administrator-style writes and continues from a bookmark", async () => {
    const session = env.DB.withSession("first-primary")
    const createdAt = "2026-01-01T00:00:00.000Z"

    await runSession(session, Effect.gen(function*() {
      const projects = yield* ProjectsRepository
      const events = yield* EventsRepository
      yield* projects.insert({
        id: "prj_session",
        name: "Session",
        slug: "session",
        icon: "",
        apiKeyHash: "session-hash",
        createdAt
      })
      yield* events.insertWithPushJobs(event("evt_session", createdAt), [])
      return yield* events.findById("evt_session")
    })).then((stored) => expect(stored?.id).toBe("evt_session"))

    const bookmark = session.getBookmark()
    expect(bookmark).not.toBeNull()
    const continued = env.DB.withSession(bookmark ?? "first-primary")
    const stored = await runSession(continued, Effect.flatMap(EventsRepository, (_) => _.findById("evt_session")))
    expect(stored?.id).toBe("evt_session")
  })

  it("keeps MCP-style grouped pagination internally consistent in one session", async () => {
    const session = env.DB.withSession("first-primary")
    await runSession(session, Effect.gen(function*() {
      const projects = yield* ProjectsRepository
      const events = yield* EventsRepository
      yield* projects.insert({
        id: "prj_session",
        name: "Session",
        slug: "session",
        icon: "",
        apiKeyHash: "session-hash",
        createdAt: "2026-01-01T00:00:00.000Z"
      })
      yield* events.insertWithPushJobs(event("evt_01", "2026-01-01T00:00:00.000Z"), [])
      yield* events.insertWithPushJobs(event("evt_02", "2026-01-02T00:00:00.000Z"), [])
      yield* events.insertWithPushJobs(event("evt_03", "2026-01-03T00:00:00.000Z", ""), [])

      const first = yield* events.list({ grouped: true, limit: 1 })
      const latest = first[0]
      expect(latest?.id).toBe("evt_03")
      const second = yield* events.list({
        grouped: true,
        limit: 2,
        cursor: { createdAt: latest?.created_at ?? "", id: latest?.id ?? "" }
      })
      expect(second.map((row) => row.id)).toEqual(["evt_02"])
      expect(second[0]?.group_count).toBe(2)
    }))
  })

  it("compares primary-only and session load paths without changing row semantics", async () => {
    await env.DB.prepare("SELECT 1").run()
    const samples = 100
    const measure = async (connection: D1Database | D1DatabaseSession) => {
      const started = performance.now()
      for (let index = 0; index < samples; index += 1) {
        const result = await connection.prepare("SELECT COUNT(*) AS count FROM projects").first<{ count: number }>()
        expect(result?.count).toBe(0)
      }
      return performance.now() - started
    }

    const primaryMs = await measure(env.DB)
    const sessionMs = await measure(env.DB.withSession("first-unconstrained"))
    expect(primaryMs).toBeGreaterThanOrEqual(0)
    expect(sessionMs).toBeGreaterThanOrEqual(0)
    console.log("D1 Sessions local load comparison", { samples, primaryMs, sessionMs })
  })
})
