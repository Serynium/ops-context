import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createEventForProject } from "../src/events.js"
import { AppConfig, CredentialCrypto, Database, PushQueue } from "../src/services.js"
import { getSettings } from "../src/settings.js"
import { matchSilence, type SilenceField } from "../src/silences.js"
import type { ProjectRow } from "../src/types.js"

const infrastructure = Layer.merge(Database.layer(env.DB), AppConfig.layer(env))

const isQueryLog = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null &&
  (value as { readonly event?: unknown }).event === "d1_query"

interface ConsoleInfoSpy {
  readonly mock: {
    readonly calls: ReadonlyArray<ReadonlyArray<unknown>>
  }
}

const queryLogs = (spy: ConsoleInfoSpy): ReadonlyArray<Record<string, unknown>> =>
  spy.mock.calls
    .map((call) => call[0])
    .filter(isQueryLog)

afterEach(() => {
  vi.restoreAllMocks()
})

describe("event-ingestion lookups", () => {
  it("uses one settings query and one silence query on a cold ingestion path", async () => {
    const createdAt = "2026-01-01T00:00:00.000Z"
    const project: ProjectRow = {
      id: "prj_cold_path",
      name: "Cold path",
      slug: "cold-path",
      icon: "",
      api_key_hash: "cold-path-hash",
      notify: 0,
      min_level: "info",
      created_at: createdAt,
      updated_at: createdAt
    }
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

    const log = vi.spyOn(console, "info").mockImplementation(() => undefined)
    await Effect.runPromise(
      createEventForProject(project, {
        title: "Cold-path event",
        fingerprint: "cold-path-fingerprint",
        source: "integration-test"
      }).pipe(Effect.provide(Layer.mergeAll(
        Database.layer(env.DB),
        AppConfig.layer(env),
        PushQueue.layer(env.PUSH_QUEUE),
        CredentialCrypto.layer
      )))
    )

    const names = queryLogs(log).map((entry) => entry.query)
    expect(names.filter((name) => name === "settings.load")).toHaveLength(1)
    expect(names.filter((name) => name === "silences.match")).toHaveLength(1)
  })

  it("loads and decodes every required setting with one named D1 query", async () => {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES
         ('retention_days', '45', '2026-01-01T00:00:00.000Z'),
         ('mcp_enabled', 'true', '2026-01-01T00:00:00.000Z')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run()
    await env.DB.prepare(
      "UPDATE settings SET value = '[\"authorization\",\"secret\"]' WHERE key = 'redact_keys'"
    ).run()

    const log = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const settings = await Effect.runPromise(getSettings.pipe(Effect.provide(infrastructure)))

    expect(settings).toMatchObject({
      retention_days: 45,
      redact_keys: ["authorization", "secret"],
      setup_completed: false,
      mcp_enabled: true
    })
    const entries = queryLogs(log)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      event: "d1_query",
      query: "settings.load",
      rows_returned: 4
    })
    expect(entries[0]).toHaveProperty("duration_ms")
    expect(entries[0]).toHaveProperty("rows_read")
    expect(entries[0]).toHaveProperty("rows_written")
  })

  it("matches every non-empty candidate combination with one query", async () => {
    const createdAt = "2026-01-01T00:00:00.000Z"
    await env.DB.prepare(
      `INSERT INTO projects
         (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
       VALUES ('prj_lookup', 'Lookup', 'lookup', '', 'lookup-hash', 0, 'info', ?, ?)`
    ).bind(createdAt, createdAt).run()
    await env.DB.prepare(
      `INSERT INTO silences (id, project_id, field, value, note, created_at) VALUES
         ('sil_project_fingerprint', 'prj_lookup', 'fingerprint', 'fp-match', '', ?),
         ('sil_project_title', 'prj_lookup', 'title', 'Title match', '', ?),
         ('sil_project_source', 'prj_lookup', 'source', 'source-match', '', ?)`
    ).bind(createdAt, createdAt, createdAt).run()

    const values: ReadonlyArray<readonly [SilenceField, string]> = [
      ["fingerprint", "fp-match"],
      ["title", "Title match"],
      ["source", "source-match"]
    ]

    for (let mask = 1; mask < 8; mask += 1) {
      const candidates = values.map(([field, value], index) =>
        [field, mask & (1 << index) ? value : ""] as const
      )
      const log = vi.spyOn(console, "info").mockImplementation(() => undefined)
      const matched = await Effect.runPromise(
        matchSilence("prj_lookup", candidates).pipe(Effect.provide(Database.layer(env.DB)))
      )

      const expected = mask & 1
        ? "sil_project_fingerprint"
        : mask & 2
          ? "sil_project_title"
          : "sil_project_source"
      expect(matched).toBe(expected)
      expect(queryLogs(log).filter((entry) => entry.query === "silences.match")).toHaveLength(1)
      log.mockRestore()
    }
  })

  it("prefers a project rule over a global rule for the same candidate", async () => {
    const createdAt = "2026-01-02T00:00:00.000Z"
    await env.DB.prepare(
      `INSERT INTO projects
         (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
       VALUES ('prj_precedence', 'Precedence', 'precedence', '', 'precedence-hash', 0, 'info', ?, ?)`
    ).bind(createdAt, createdAt).run()
    await env.DB.prepare(
      `INSERT INTO silences (id, project_id, field, value, note, created_at) VALUES
         ('sil_global', NULL, 'title', 'Shared title', '', ?),
         ('sil_project', 'prj_precedence', 'title', 'Shared title', '', ?)`
    ).bind(createdAt, createdAt).run()

    const matched = await Effect.runPromise(
      matchSilence("prj_precedence", [
        ["fingerprint", ""],
        ["title", "Shared title"],
        ["source", ""]
      ]).pipe(Effect.provide(Database.layer(env.DB)))
    )

    expect(matched).toBe("sil_project")
  })

  it("ignores empty candidates without querying D1", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const matched = await Effect.runPromise(
      matchSilence("prj_empty", [
        ["fingerprint", ""],
        ["title", ""],
        ["source", ""]
      ]).pipe(Effect.provide(Database.layer(env.DB)))
    )

    expect(matched).toBeNull()
    expect(queryLogs(log).filter((entry) => entry.query === "silences.match")).toHaveLength(0)
  })
})
