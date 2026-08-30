import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { compileEventSearchQuery, listEvents } from "../src/events.js"
import { D1RepositoriesLive, EventsRepository } from "../src/repositories.js"

const reset = async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM push_jobs"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM silences"),
    env.DB.prepare("DELETE FROM projects")
  ])
}

const insertProject = async (id: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO projects
      (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, 0, 'info', '2026-01-01', '2026-01-01')`
  ).bind(id, id, id, `hash-${id}`).run()
}

interface EventFixture {
  readonly id: string
  readonly projectId?: string
  readonly title: string
  readonly body?: string
  readonly source?: string
  readonly fingerprint?: string
  readonly payload?: Record<string, unknown>
  readonly createdAt: string
}

const insertEvent = async (fixture: EventFixture): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO events
      (id, external_id, project_id, source, type, level, title, body, fingerprint,
       payload_json, actions_json, occurred_at, created_at, silence_id)
     VALUES (?, NULL, ?, ?, 'fixture', 'error', ?, ?, ?, ?, '[]', ?, ?, NULL)`
  ).bind(
    fixture.id,
    fixture.projectId ?? "prj_a",
    fixture.source ?? "worker",
    fixture.title,
    fixture.body ?? "",
    fixture.fingerprint ?? "",
    JSON.stringify(fixture.payload ?? {}),
    fixture.createdAt,
    fixture.createdAt
  ).run()
}

const run = <A>(effect: Effect.Effect<A, unknown, EventsRepository>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(D1RepositoriesLive(env.DB))))

const searchIds = async (
  search: string,
  input: Omit<Parameters<typeof listEvents>[0], "search"> = {}
): Promise<ReadonlyArray<string>> => {
  const page = await run(listEvents({ ...input, search }))
  return page.events.map((event) => event.id)
}

const rebuild = async (): Promise<void> => {
  await env.DB.prepare("DELETE FROM event_search").run()
  await env.DB.prepare(
    `INSERT INTO event_search(rowid, title, body, source, fingerprint, payload)
     SELECT
       e.rowid,
       e.title,
       e.body,
       e.source,
       e.fingerprint,
       COALESCE((
         SELECT group_concat(CASE value.type
           WHEN 'true' THEN 'true'
           WHEN 'false' THEN 'false'
           ELSE CAST(value.atom AS TEXT)
         END, ' ')
         FROM json_tree(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END) AS value
         WHERE value.atom IS NOT NULL
           AND value.type IN ('text', 'integer', 'real', 'true', 'false')
           AND CAST(value.atom AS TEXT) <> '[REDACTED]'
       ), '')
     FROM events AS e`
  ).run()
}

describe("FTS5 event search", () => {
  beforeEach(async () => {
    await reset()
    await insertProject("prj_a")
    await insertProject("prj_b")
  })

  it("supports Unicode tokens, phrases, explicit prefixes, and safe escaping", async () => {
    await insertEvent({
      id: "evt_04",
      title: "Café database connection timeout",
      body: "deploy blue release",
      createdAt: "2026-01-04T00:00:00.000Z"
    })
    await insertEvent({
      id: "evt_03",
      title: "Cafeteria is open",
      body: "blue deploy release",
      createdAt: "2026-01-03T00:00:00.000Z"
    })
    await insertEvent({
      id: "evt_02",
      title: "Quoted alpha event",
      createdAt: "2026-01-02T00:00:00.000Z"
    })
    await insertEvent({
      id: "evt_01",
      title: "Error while waiting for timeout",
      createdAt: "2026-01-01T00:00:00.000Z"
    })

    expect(await searchIds("cafe")).toEqual(["evt_04"])
    expect(await searchIds("caf*")).toEqual(["evt_04", "evt_03"])
    expect(await searchIds('"deploy blue"')).toEqual(["evt_04"])
    expect(await searchIds("error-timeout")).toEqual(["evt_01"])
    expect(await searchIds("error_timeout")).toEqual(["evt_01"])
    expect(await searchIds("afe")).toEqual([])
    expect(await searchIds('alpha" OR cafeteria')).toEqual([])
    expect(compileEventSearchQuery("error-timeout")).toBe('"error" AND "timeout"')
    expect(compileEventSearchQuery("error_timeout")).toBe('"error" AND "timeout"')
    expect(compileEventSearchQuery("error-time*")).toBe('"error" AND "time"*')
    expect(compileEventSearchQuery('alpha" OR cafeteria')).toBe('"alpha" AND "OR" AND "cafeteria"')
    await expect(run(listEvents({ search: '"unterminated' }))).rejects.toMatchObject({
      _tag: "InvalidEventQuery",
      message: "search phrase has an unterminated quote"
    })
    await expect(run(listEvents({ search: `"${"a".repeat(240)}"` }))).rejects.toMatchObject({
      _tag: "InvalidEventQuery",
      message: "search must be at most 240 characters"
    })
    await expect(run(listEvents({ search: "timeout\0other" }))).rejects.toMatchObject({
      _tag: "InvalidEventQuery",
      message: "search must not contain NUL characters"
    })
  })

  it("indexes normalized redacted payload values without indexing raw JSON syntax", async () => {
    await insertEvent({
      id: "evt_payload",
      title: "Payload projection",
      payload: {
        password: "[REDACTED]",
        region: "eu-west",
        nested: { trace: "visible-trace" }
      },
      createdAt: "2026-01-05T00:00:00.000Z"
    })
    await insertEvent({
      id: "evt_boolean",
      title: "Boolean payload",
      payload: { enabled: true, disabled: false },
      createdAt: "2026-01-04T00:00:00.000Z"
    })
    await insertEvent({
      id: "evt_numeric",
      title: "Numeric payload",
      payload: { one: 1, zero: 0 },
      createdAt: "2026-01-03T00:00:00.000Z"
    })

    expect(await searchIds('"eu west"')).toEqual(["evt_payload"])
    expect(await searchIds('"visible trace"')).toEqual(["evt_payload"])
    expect(await searchIds("password")).toEqual([])
    expect(await searchIds("redacted")).toEqual([])
    expect(await searchIds("true")).toEqual(["evt_boolean"])
    expect(await searchIds("false")).toEqual(["evt_boolean"])
    expect(await searchIds("1")).toEqual(["evt_numeric"])
    expect(await searchIds("0")).toEqual(["evt_numeric"])
  })

  it("keeps project, time, grouped, ordering, and cursor constraints on normal event columns", async () => {
    await insertEvent({ id: "evt_06", title: "Timeout newest", fingerprint: "group-a", createdAt: "2026-01-06T00:00:00.000Z" })
    await insertEvent({ id: "evt_05", title: "Timeout grouped", fingerprint: "group-a", createdAt: "2026-01-05T00:00:00.000Z" })
    await insertEvent({ id: "evt_04", title: "Timeout middle", createdAt: "2026-01-04T00:00:00.000Z" })
    await insertEvent({ id: "evt_03", title: "Timeout old", createdAt: "2026-01-03T00:00:00.000Z" })
    await insertEvent({ id: "evt_other", projectId: "prj_b", title: "Timeout other", createdAt: "2026-01-07T00:00:00.000Z" })

    const first = await run(listEvents({
      project: "prj_a",
      search: "timeout",
      since: "2026-01-03T12:00:00Z",
      limit: "2"
    }))
    expect(first.events.map((event) => event.id)).toEqual(["evt_06", "evt_05"])
    expect(first.next_cursor).toBeDefined()

    const second = await run(listEvents({
      project: "prj_a",
      search: "timeout",
      since: "2026-01-03T12:00:00Z",
      before: first.next_cursor,
      limit: "2"
    }))
    expect(second.events.map((event) => event.id)).toEqual(["evt_04"])

    const grouped = await run(listEvents({
      project: "prj_a",
      search: "timeout",
      grouped: "true"
    }))
    expect(grouped.events.map((event) => event.id)).toEqual(["evt_06", "evt_04", "evt_03"])
    expect(grouped.events[0]?.group?.count).toBe(2)
  })

  it("maintains the index across update, retention deletion, and project cascade deletion", async () => {
    await insertEvent({ id: "evt_update", title: "Before rename", createdAt: "2026-01-04T00:00:00.000Z" })
    await insertEvent({ id: "evt_retained", title: "Retention marker", createdAt: "2026-01-03T00:00:00.000Z" })
    await insertEvent({ id: "evt_project", projectId: "prj_b", title: "Cascade marker", createdAt: "2026-01-02T00:00:00.000Z" })

    await env.DB.prepare("UPDATE events SET title = ? WHERE id = ?").bind("After rename", "evt_update").run()
    expect(await searchIds("before")).toEqual([])
    expect(await searchIds("after")).toEqual(["evt_update"])

    await env.DB.prepare("DELETE FROM events WHERE created_at < ?")
      .bind("2026-01-04T00:00:00.000Z")
      .run()
    expect(await searchIds("retention")).toEqual([])

    await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind("prj_b").run()
    expect(await searchIds("cascade")).toEqual([])
    const indexed = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM event_search"
    ).first<{ readonly count: number }>()
    expect(indexed?.count).toBe(1)
  })

  it("rebuilds and backfills idempotently", async () => {
    await insertEvent({ id: "evt_rebuild", title: "Rebuild marker", createdAt: "2026-01-04T00:00:00.000Z" })
    await rebuild()
    await rebuild()

    expect(await searchIds("rebuild")).toEqual(["evt_rebuild"])
    const indexed = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM event_search
       JOIN events ON events.rowid = event_search.rowid
       WHERE events.id = ?`
    ).bind("evt_rebuild").first<{ readonly count: number }>()
    expect(indexed?.count).toBe(1)
  })
})
