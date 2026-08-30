import { Effect, Logger } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  D1StructuredLoggerLive,
  d1SuccessTelemetry
} from "../src/database-observability.js"
import { Database } from "../src/services.js"

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
})
