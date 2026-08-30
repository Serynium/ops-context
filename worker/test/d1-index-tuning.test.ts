import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { listEvents } from "../src/events.js"
import { Database } from "../src/services.js"

interface QueryPlanRow {
  readonly detail: string
}

const reset = async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM push_jobs"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM silences"),
    env.DB.prepare("DELETE FROM projects")
  ])
}

const seedEvents = async (): Promise<void> => {
  const project = env.DB.prepare(
    `INSERT INTO projects
      (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, 0, 'info', ?, ?)`
  )
  await env.DB.batch([
    project.bind("prj_a", "Project A", "project-a", "hash-a", "2026-01-01", "2026-01-01"),
    project.bind("prj_b", "Project B", "project-b", "hash-b", "2026-01-01", "2026-01-01")
  ])

  const event = env.DB.prepare(
    `INSERT INTO events
      (id, external_id, project_id, source, type, level, title, body, fingerprint,
       payload_json, actions_json, occurred_at, created_at, silence_id)
     VALUES (?, NULL, ?, ?, 'fixture', ?, ?, '', ?, '{}', '[]', ?, ?, NULL)`
  )
  const rows = [
    ["evt_06", "prj_a", "api", "info", "Newest ungrouped", "", "2026-01-06"],
    ["evt_05", "prj_a", "cron", "error", "Latest repeat", "repeat", "2026-01-06"],
    ["evt_04", "prj_a", "cron", "error", "Older repeat", "repeat", "2026-01-04"],
    ["evt_03", "prj_a", "worker", "warning", "Older ungrouped", "", "2026-01-03"],
    ["evt_02", "prj_a", "api", "info", "Oldest", "other", "2026-01-02"],
    ["evt_99", "prj_b", "api", "critical", "Other project", "other", "2026-01-09"]
  ] as const
  await env.DB.batch(rows.map(([id, projectId, source, level, title, fingerprint, createdAt]) =>
    event.bind(id, projectId, source, level, title, fingerprint, createdAt, createdAt)
  ))
}

const plansFor = async (sql: string, ...params: ReadonlyArray<unknown>): Promise<string> => {
  const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<QueryPlanRow>()
  return result.results.map((row) => row.detail).join("\n")
}

describe("measured D1 index tuning", () => {
  beforeEach(reset)

  it("uses query-shaped indexes for every measured hot read family", async () => {
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name"
    ).all<{ readonly name: string }>()
    const names = indexes.results.map((row) => row.name)
    expect(names).toContain("events_project_created")
    expect(names).not.toContain("events_project_id")

    const eventList = await plansFor(
      `SELECT id FROM events
       WHERE project_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 51`,
      "prj_a"
    )
    expect(eventList).toContain("events_project_created")
    expect(eventList).not.toContain("TEMP B-TREE")

    const grouped = await plansFor(
      `SELECT id FROM events
       WHERE project_id = ? AND fingerprint <> ''
       ORDER BY fingerprint, created_at DESC, id DESC`,
      "prj_a"
    )
    expect(grouped).toContain("events_project_fingerprint_created")
    expect(grouped).not.toContain("TEMP B-TREE")

    const recovery = await plansFor(
      `SELECT event_id, subscription_id FROM push_jobs
       WHERE
         (state = 'pending' AND available_at <= ?)
         OR (state = 'queued' AND available_at <= ? AND (queued_at IS NULL OR queued_at < ?))
         OR (state = 'sending' AND (lease_until IS NULL OR lease_until < ?))
       ORDER BY available_at LIMIT 100`,
      "2026-12-31",
      "2026-12-31",
      "2026-12-31",
      "2026-12-31"
    )
    expect(recovery).toContain("push_jobs_recovery")
    expect(recovery).toContain("push_jobs_lease")
    expect(recovery).not.toContain("SCAN push_jobs")

    expect(await plansFor(
      "SELECT * FROM deliveries WHERE event_id = ? ORDER BY attempted_at DESC",
      "evt_01"
    )).toContain("deliveries_event_id")
    expect(await plansFor(
      "SELECT * FROM projects WHERE api_key_hash = ?",
      "hash-a"
    )).toContain("api_key_hash")
    expect(await plansFor(
      `SELECT id FROM silences
       WHERE field = ? AND value = ? AND (project_id IS NULL OR project_id = ?)
       ORDER BY CASE WHEN project_id IS NULL THEN 1 ELSE 0 END LIMIT 1`,
      "source",
      "cron",
      "prj_a"
    )).toContain("silences_lookup")
  })

  it("preserves project ordering, cursor pagination, filters, and ungrouped events", async () => {
    await seedEvents()
    const run = <A>(effect: Effect.Effect<A, unknown, Database>) =>
      Effect.runPromise(effect.pipe(Effect.provide(Database.layer(env.DB))))

    const first = await run(listEvents({ project: "prj_a", limit: "2" }))
    expect(first.events.map((event) => event.id)).toEqual(["evt_06", "evt_05"])
    expect(first.next_cursor).toBeDefined()

    const second = await run(listEvents({
      project: "prj_a",
      before: first.next_cursor,
      limit: "2"
    }))
    expect(second.events.map((event) => event.id)).toEqual(["evt_04", "evt_03"])

    const filtered = await run(listEvents({
      project: "prj_a",
      level: "error",
      source: "cron"
    }))
    expect(filtered.events.map((event) => event.id)).toEqual(["evt_05", "evt_04"])

    const grouped = await run(listEvents({ project: "prj_a", grouped: "true" }))
    expect(grouped.events.map((event) => event.id)).toEqual([
      "evt_06",
      "evt_05",
      "evt_03",
      "evt_02"
    ])
    expect(grouped.events.find((event) => event.id === "evt_05")?.group).toMatchObject({
      count: 2,
      first_seen: "2026-01-04",
      last_seen: "2026-01-06"
    })
    expect(grouped.events.find((event) => event.id === "evt_06")?.group).toBeUndefined()
  })
})
