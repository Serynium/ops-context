import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { deleteProject, listProjects, updateProject } from "../src/projects.js"
import { D1RepositoriesLive } from "../src/repositories.js"

describe("project pagination", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM projects").run()
    for (const [id, name] of [["prj_c", "Charlie"], ["prj_a", "alpha"], ["prj_b", "Bravo"]] as const) {
      await env.DB.prepare(
        `INSERT INTO projects
         (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, 0, 'info', '2026-01-01', '2026-01-01')`
      ).bind(id, name, id, `hash-${id}`).run()
    }
  })

  it("returns stable cursor pages without duplicates", async () => {
    const run = (before?: string) => Effect.runPromise(
      listProjects({ limit: "2", ...(before ? { before } : {}) }).pipe(
        Effect.provide(D1RepositoriesLive(env.DB))
      )
    )
    const first = await run()
    const second = await run(first.next_cursor)

    expect(first.projects.map((project) => project.id)).toEqual(["prj_a", "prj_b"])
    expect(first.next_cursor).toBeDefined()
    expect(second.projects.map((project) => project.id)).toEqual(["prj_c"])
    expect(second.next_cursor).toBeUndefined()
  })

  it("allows deleting the last project", async () => {
    await env.DB.prepare("DELETE FROM projects WHERE id <> 'prj_a'").run()
    await Effect.runPromise(deleteProject("prj_a").pipe(
      Effect.provide(D1RepositoriesLive(env.DB))
    ))
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM projects")
      .first<{ readonly count: number }>()
    expect(remaining?.count).toBe(0)
  })

  it("keeps complete icon identifiers", async () => {
    const project = await Effect.runPromise(updateProject("prj_a", {
      icon: "circle:periwinkle"
    }).pipe(Effect.provide(D1RepositoriesLive(env.DB))))
    expect(project.icon).toBe("circle:periwinkle")
  })
})
