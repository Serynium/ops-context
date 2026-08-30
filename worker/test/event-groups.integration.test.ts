import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { rebuildEventGroups } from "../src/event-groups.js"
import { listEvents } from "../src/events.js"
import { D1RepositoriesLive, EventsRepository } from "../src/repositories.js"
import { Database } from "../src/services.js"

interface GroupRow {
  readonly project_id: string
  readonly fingerprint: string
  readonly latest_event_id: string
  readonly occurrence_count: number
  readonly first_seen: string
  readonly last_seen: string
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

const insertProject = async (id: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO projects
      (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, 0, 'info', '2026-01-01', '2026-01-01')`
  ).bind(id, id, id, `hash-${id}`).run()
}

const insertEvent = async (
  id: string,
  projectId: string,
  fingerprint: string,
  createdAt: string,
  level = "info"
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO events
      (id, external_id, project_id, source, type, level, title, body, fingerprint,
       payload_json, actions_json, occurred_at, created_at, silence_id)
     VALUES (?, NULL, ?, 'test', 'fixture', ?, ?, '', ?, '{}', '[]', ?, ?, NULL)`
  ).bind(id, projectId, level, id, fingerprint, createdAt, createdAt).run()
}

const run = <A>(effect: Effect.Effect<A, unknown, Database | EventsRepository>) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(D1RepositoriesLive(env.DB)),
    Effect.provide(Database.layer(env.DB))
  ))

const groups = async (): Promise<ReadonlyArray<GroupRow>> => {
  const result = await env.DB.prepare(
    "SELECT * FROM event_groups ORDER BY project_id, fingerprint"
  ).all<GroupRow>()
  return result.results
}

describe("grouped-event read model", () => {
  beforeEach(reset)

  it("matches the exact dynamic query while isolating projects and empty fingerprints", async () => {
    await insertProject("prj_a")
    await insertProject("prj_b")
    await insertEvent("evt_a1", "prj_a", "repeat", "2026-01-01T00:00:00.000Z")
    await insertEvent("evt_a3", "prj_a", "repeat", "2026-01-03T00:00:00.000Z")
    await insertEvent("evt_a2", "prj_a", "", "2026-01-02T00:00:00.000Z")
    await insertEvent("evt_b1", "prj_b", "repeat", "2026-01-04T00:00:00.000Z")
    await insertEvent("evt_b2", "prj_b", "", "2026-01-05T00:00:00.000Z")

    expect(await groups()).toEqual([
      {
        project_id: "prj_a",
        fingerprint: "repeat",
        latest_event_id: "evt_a3",
        occurrence_count: 2,
        first_seen: "2026-01-01T00:00:00.000Z",
        last_seen: "2026-01-03T00:00:00.000Z"
      },
      {
        project_id: "prj_b",
        fingerprint: "repeat",
        latest_event_id: "evt_b1",
        occurrence_count: 1,
        first_seen: "2026-01-04T00:00:00.000Z",
        last_seen: "2026-01-04T00:00:00.000Z"
      }
    ])

    const fast = await run(listEvents({ grouped: "true" }))
    const dynamic = await run(listEvents({ grouped: "true", since: "1970-01-01T00:00:00.000Z" }))
    expect(fast).toEqual(dynamic)
    expect(fast.events.map((event) => event.id)).toEqual(["evt_b2", "evt_b1", "evt_a3", "evt_a2"])
    expect(fast.events.find((event) => event.id === "evt_a2")?.group).toBeUndefined()

    const fastProject = await run(listEvents({ grouped: "true", project: "prj_a" }))
    const dynamicProject = await run(listEvents({
      grouped: "true",
      project: "prj_a",
      since: "1970-01-01T00:00:00.000Z"
    }))
    expect(fastProject).toEqual(dynamicProject)

    const fastFirst = await run(listEvents({ grouped: "true", limit: "2" }))
    const dynamicFirst = await run(listEvents({
      grouped: "true",
      since: "1970-01-01T00:00:00.000Z",
      limit: "2"
    }))
    expect(fastFirst).toEqual(dynamicFirst)
    const fastSecond = await run(listEvents({
      grouped: "true",
      before: fastFirst.next_cursor,
      limit: "2"
    }))
    const dynamicSecond = await run(listEvents({
      grouped: "true",
      since: "1970-01-01T00:00:00.000Z",
      before: dynamicFirst.next_cursor,
      limit: "2"
    }))
    expect(fastSecond).toEqual(dynamicSecond)
  })

  it("keeps counts and representatives correct after out-of-order inserts and retention deletes", async () => {
    await insertProject("prj_retention")
    await insertEvent("evt_middle", "prj_retention", "job", "2026-01-02T00:00:00.000Z")
    await insertEvent("evt_latest_a", "prj_retention", "job", "2026-01-03T00:00:00.000Z")
    await insertEvent("evt_first", "prj_retention", "job", "2026-01-01T00:00:00.000Z")
    await insertEvent("evt_latest_b", "prj_retention", "job", "2026-01-03T00:00:00.000Z")

    expect((await groups())[0]).toMatchObject({
      latest_event_id: "evt_latest_b",
      occurrence_count: 4,
      first_seen: "2026-01-01T00:00:00.000Z",
      last_seen: "2026-01-03T00:00:00.000Z"
    })

    await env.DB.prepare("DELETE FROM events WHERE created_at < ?")
      .bind("2026-01-03T00:00:00.000Z")
      .run()
    expect((await groups())[0]).toMatchObject({
      latest_event_id: "evt_latest_b",
      occurrence_count: 2,
      first_seen: "2026-01-03T00:00:00.000Z",
      last_seen: "2026-01-03T00:00:00.000Z"
    })

    await env.DB.prepare("DELETE FROM events WHERE id = 'evt_latest_b'").run()
    expect((await groups())[0]).toMatchObject({
      latest_event_id: "evt_latest_a",
      occurrence_count: 1
    })

    await env.DB.prepare("DELETE FROM events WHERE id = 'evt_latest_a'").run()
    expect(await groups()).toEqual([])
  })

  it("repairs drift idempotently from source events", async () => {
    await insertProject("prj_repair")
    await insertEvent("evt_old", "prj_repair", "repair", "2026-01-01T00:00:00.000Z")
    await insertEvent("evt_new", "prj_repair", "repair", "2026-01-02T00:00:00.000Z")
    await env.DB.prepare(
      "UPDATE event_groups SET occurrence_count = 99, latest_event_id = 'evt_old'"
    ).run()

    await run(rebuildEventGroups)
    const once = await groups()
    await run(rebuildEventGroups)
    expect(await groups()).toEqual(once)
    expect(once[0]).toMatchObject({
      latest_event_id: "evt_new",
      occurrence_count: 2,
      first_seen: "2026-01-01T00:00:00.000Z",
      last_seen: "2026-01-02T00:00:00.000Z"
    })
  })

  it("uses the exact dynamic query for unsupported filters", async () => {
    await insertProject("prj_filters")
    await insertEvent("evt_info", "prj_filters", "same", "2026-01-01T00:00:00.000Z", "info")
    await insertEvent("evt_error", "prj_filters", "same", "2026-01-02T00:00:00.000Z", "error")

    const filtered = await run(listEvents({ grouped: "true", level: "info" }))
    expect(filtered.events).toHaveLength(1)
    expect(filtered.events[0]).toMatchObject({
      id: "evt_info",
      group: { count: 1 }
    })
  })

  it("measures the default grouped page below the enablement threshold", async () => {
    await insertProject("prj_measure")
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 10000
       )
       INSERT INTO events (
         id, external_id, project_id, source, type, level, title, body, fingerprint,
         payload_json, actions_json, occurred_at, created_at, silence_id
       )
       SELECT
         printf('evt_measure_%05d', value), NULL, 'prj_measure', 'fixture', 'fixture',
         'info', 'Measured event', '', printf('fingerprint_%03d', value % 500),
         '{}', '[]', printf('2026-01-%02dT00:00:00.000Z', 1 + (value % 28)),
         printf('2026-01-%02dT00:00:00.000Z', 1 + (value % 28)), NULL
       FROM sequence`
    ).run()

    const dynamicSql = `WITH fingerprinted AS (
      SELECT id, project_id, fingerprint, created_at,
        COUNT(*) OVER (PARTITION BY project_id, fingerprint) AS group_count,
        MIN(created_at) OVER (PARTITION BY project_id, fingerprint) AS first_seen,
        MAX(created_at) OVER (PARTITION BY project_id, fingerprint) AS last_seen,
        ROW_NUMBER() OVER (
          PARTITION BY project_id, fingerprint ORDER BY created_at DESC, id DESC
        ) AS group_rank
      FROM events
      WHERE fingerprint <> ''
    )
    SELECT id, project_id, fingerprint, created_at, group_count, first_seen, last_seen
    FROM fingerprinted
    WHERE group_rank = 1
    ORDER BY created_at DESC, id DESC
    LIMIT 51`

    const fastSql = `WITH grouped_representatives AS (
      SELECT e.id, g.project_id, g.fingerprint, e.created_at,
        g.occurrence_count AS group_count, g.first_seen, g.last_seen
      FROM event_groups g
      JOIN events e ON e.id = g.latest_event_id
      ORDER BY g.last_seen DESC, g.latest_event_id DESC
      LIMIT 51
    ), ungrouped_representatives AS (
      SELECT id, project_id, fingerprint, created_at,
        1 AS group_count, created_at AS first_seen, created_at AS last_seen
      FROM events INDEXED BY events_empty_fingerprint_created
      WHERE fingerprint = ''
      ORDER BY created_at DESC, id DESC
      LIMIT 51
    ), representatives AS (
      SELECT * FROM grouped_representatives
      UNION ALL
      SELECT * FROM ungrouped_representatives
    )
    SELECT * FROM representatives
    ORDER BY created_at DESC, id DESC
    LIMIT 51`

    const measure = async (sql: string): Promise<{
      readonly rowsRead: number
      readonly medianMs: number
    }> => {
      const durations: Array<number> = []
      let rowsRead = 0
      for (let iteration = 0; iteration < 11; iteration += 1) {
        const started = performance.now()
        const result = await env.DB.prepare(sql).all()
        const elapsed = performance.now() - started
        if (iteration > 0) durations.push(elapsed)
        rowsRead = (result.meta as { readonly rows_read?: number }).rows_read ?? 0
      }
      durations.sort((left, right) => left - right)
      return { rowsRead, medianMs: durations[Math.floor(durations.length / 2)] ?? 0 }
    }

    const dynamic = await measure(dynamicSql)
    const fast = await measure(fastSql)
    console.log("grouped inbox benchmark", { dynamic, fast })

    expect(fast.rowsRead).toBeLessThan(dynamic.rowsRead * 0.2)
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${fastSql}`)
      .all<{ readonly detail: string }>()
    const planText = plan.results.map((row) => row.detail).join("\n")
    expect(planText).toContain("SCAN g USING INDEX event_groups_latest")
    expect(planText).toContain("events_empty_fingerprint_created")
  })
})
