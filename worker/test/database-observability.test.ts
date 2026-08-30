import { Effect, Logger } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  D1StructuredLoggerLive,
  d1SuccessTelemetry
} from "../src/database-observability.js"
import type { RepositoryUnavailable } from "../src/errors.js"
import { Database, type DatabaseService } from "../src/services.js"

const result = <A>(results: A[], overrides: Partial<D1Meta> = {}): D1Result<A> => ({
  success: true,
  results,
  meta: {
    duration: 4.5,
    size_after: 1_024,
    rows_read: 12,
    rows_written: 3,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
    ...overrides
  }
})

const unsuccessfulResult = <A>(results: A[] = []): D1Result<A> => ({
  ...result(results),
  success: false,
  error: "driver detail that must not be logged"
} as unknown as D1Result<A>)

const unsuccessfulOperationCases: ReadonlyArray<readonly [
  string,
  (database: DatabaseService) => Effect.Effect<unknown, RepositoryUnavailable>
]> = [
  ["read", (database) => database.all("events.list", "SELECT * FROM events")],
  ["write", (database) => database.run("events.create", "INSERT INTO events DEFAULT VALUES")]
]

describe("D1 query observability", () => {
  it("extracts row counts and prefers the precise SQL duration", () => {
    expect(d1SuccessTelemetry("events.list", "query", result(
      [{ id: "one" }, { id: "two" }],
      { timings: { sql_duration_ms: 2.25 } }
    ))).toEqual({
      event: "d1.query",
      "db.system": "cloudflare-d1",
      "db.query.name": "events.list",
      "db.operation": "query",
      "db.rows_returned": 2,
      "db.rows_read": 12,
      "db.rows_written": 3,
      "db.duration_ms": 2.25
    })
  })

  it("logs metadata without SQL text or bound values", async () => {
    const messages: Array<unknown> = []
    const logger = Logger.make(({ message }) => {
      messages.push(message)
    })
    const db = {
      prepare: () => ({
        bind: () => ({
          all: () => Promise.resolve(result([{ id: "evt_1" }]))
        })
      })
    } as unknown as D1Database

    await Effect.runPromise(
      Effect.flatMap(Database, (database) =>
        database.all<{ readonly id: string }>(
          "events.get_by_external_id",
          "SELECT id FROM events WHERE external_id = ?",
          ["secret-external-id"]
        )
      ).pipe(
        Effect.provide(Database.layer(db)),
        Effect.provide(Logger.layer([logger]))
      )
    )

    const serialized = JSON.stringify(messages)
    expect(serialized).toContain("events.get_by_external_id")
    expect(serialized).toContain("db.rows_read")
    expect(serialized).not.toContain("SELECT id")
    expect(serialized).not.toContain("secret-external-id")
  })

  it("forwards telemetry as a top-level structured console record", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const db = {
      prepare: () => ({
        bind: () => ({
          all: () => Promise.resolve(result([{ id: "evt_1" }]))
        })
      })
    } as unknown as D1Database

    await Effect.runPromise(
      Effect.flatMap(Database, (database) =>
        database.all("events.list", "SELECT * FROM events")
      ).pipe(
        Effect.provide(Database.layer(db)),
        Effect.provide(D1StructuredLoggerLive)
      )
    )

    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "d1.query",
      "db.query.name": "events.list",
      "db.rows_read": 12
    }))
    consoleLog.mockRestore()
  })

  it("classifies failures without logging driver error messages", async () => {
    const messages: Array<unknown> = []
    const logger = Logger.make(({ message }) => {
      messages.push(message)
    })
    const db = {
      prepare: () => ({
        bind: () => ({
          all: () => Promise.reject(new Error("driver leaked secret-external-id"))
        })
      })
    } as unknown as D1Database

    await Effect.runPromise(
      Effect.flatMap(Database, (database) =>
        database.all("events.list", "SELECT * FROM events", ["secret-external-id"])
      ).pipe(
        Effect.catch(() => Effect.void),
        Effect.provide(Database.layer(db)),
        Effect.provide(Logger.layer([logger]))
      )
    )

    expect(messages).toEqual([[{
      event: "d1.query.failed",
      "db.system": "cloudflare-d1",
      "db.query.name": "events.list",
      "db.operation": "query",
      "error.class": "d1_query_failed"
    }]])
    expect(JSON.stringify(messages)).not.toContain("secret-external-id")
  })

  it.each(unsuccessfulOperationCases)("rejects unsuccessful D1 %s result objects", async (_kind, operation) => {
    const messages: Array<unknown> = []
    const logger = Logger.make(({ message }) => {
      messages.push(message)
    })
    const db = {
      prepare: () => ({
        bind: () => ({
          all: () => Promise.resolve(unsuccessfulResult()),
          run: () => Promise.resolve(unsuccessfulResult())
        })
      })
    } as unknown as D1Database

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Database, operation).pipe(
        Effect.provide(Database.layer(db)),
        Effect.provide(Logger.layer([logger]))
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).toContain("d1.query.failed")
    expect(JSON.stringify(messages)).not.toContain("driver detail")
  })

  it("rejects a batch when any D1 result is unsuccessful", async () => {
    const messages: Array<unknown> = []
    const logger = Logger.make(({ message }) => {
      messages.push(message)
    })
    const db = {
      prepare: (sql: string) => ({ sql, bind: () => ({ sql }) }),
      batch: () => Promise.resolve([result([]), unsuccessfulResult()])
    } as unknown as D1Database

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Database, (database) => database.batch("events.create_batch", [
        { name: "events.insert", sql: "INSERT INTO events DEFAULT VALUES" },
        { name: "subscriptions.touch", sql: "UPDATE subscriptions SET updated_at = 1" }
      ])).pipe(
        Effect.provide(Database.layer(db)),
        Effect.provide(Logger.layer([logger]))
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).toContain("d1.query.failed")
    expect(JSON.stringify(messages)).not.toContain("d1.query\"")
    expect(JSON.stringify(messages)).not.toContain("driver detail")
  })
})
