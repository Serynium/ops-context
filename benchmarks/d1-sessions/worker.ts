interface Env {
  readonly DB: D1Database
  readonly BENCHMARK_TOKEN: string
}

const resultMeta = (result: D1Result<unknown>) => ({
  duration_ms: result.meta.duration,
  served_by_region: result.meta.served_by_region ?? null,
  served_by_primary: result.meta.served_by_primary ?? null,
  rows_read: result.meta.rows_read ?? null
})

const query = `SELECT id, project_id, title, created_at
  FROM events
  WHERE project_id = ?
  ORDER BY created_at DESC, id DESC
  LIMIT 50`

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const colo = request.cf?.colo ?? null
    if (request.headers.get("authorization") !== `Bearer ${env.BENCHMARK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 })
    }

    if (url.pathname === "/seed") {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`).run()
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS events_project_created
        ON events(project_id, created_at DESC, id DESC)`).run()
      await env.DB.prepare("DELETE FROM events").run()
      const inserted = await env.DB.prepare(`WITH RECURSIVE rows(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 10000
      ) INSERT INTO events (id, project_id, title, created_at)
        SELECT printf('evt_%05d', n), printf('prj_%02d', n % 10),
          printf('Synthetic event %05d', n), printf('2026-01-%02dT00:00:00.000Z', (n % 28) + 1)
        FROM rows`).run()
      return Response.json({ colo, inserted: resultMeta(inserted) })
    }

    if (url.pathname === "/query") {
      const mode = url.searchParams.get("mode") ?? "primary"
      const connection = mode === "session"
        ? env.DB.withSession("first-unconstrained")
        : mode === "session-latest"
          ? env.DB.withSession("first-primary")
          : env.DB
      const started = performance.now()
      const result = await connection.prepare(query).bind("prj_01").all()
      return Response.json({
        colo,
        mode,
        wall_ms: performance.now() - started,
        count: result.results.length,
        meta: resultMeta(result),
        bookmark: mode === "primary" ? null : (connection as D1DatabaseSession).getBookmark()
      })
    }

    if (url.pathname === "/consistency") {
      const id = `consistency_${crypto.randomUUID()}`
      const session = env.DB.withSession("first-primary")
      await session.prepare(
        "INSERT INTO events (id, project_id, title, created_at) VALUES (?, 'prj_01', 'Consistency probe', ?)"
      ).bind(id, new Date().toISOString()).run()
      const sameSession = await session.prepare("SELECT id FROM events WHERE id = ?").bind(id).first<{ id: string }>()
      const bookmark = session.getBookmark()
      const continued = bookmark === null
        ? null
        : await env.DB.withSession(bookmark).prepare("SELECT id FROM events WHERE id = ?").bind(id).first<{ id: string }>()
      return Response.json({
        colo,
        bookmark: bookmark !== null,
        same_session_read_after_write: sameSession?.id === id,
        continued_session_read_after_write: continued?.id === id
      })
    }

    return new Response("Not found", { status: 404 })
  }
} satisfies ExportedHandler<Env>
