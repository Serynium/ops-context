import { Effect } from "effect"
import { invalid, notFound, type AppError } from "./errors.js"
import { newId, nowIso } from "./ids.js"
import { CredentialCrypto, Database } from "./services.js"
import type { SilenceRow } from "./types.js"

export type SilenceField = "fingerprint" | "title" | "source"

export interface CreateSilenceInput {
  readonly project_id?: string
  readonly field: SilenceField
  readonly value: string
  readonly note?: string
}

const fields = new Set<SilenceField>(["fingerprint", "title", "source"])

export const listSilences: Effect.Effect<ReadonlyArray<SilenceRow>, AppError, Database> =
  Effect.gen(function*() {
    const db = yield* Database
    return yield* db.all<SilenceRow>(
      `SELECT s.*, p.name AS project_name
       FROM silences s
       LEFT JOIN projects p ON p.id = s.project_id
       ORDER BY s.created_at DESC`
    )
  })

export const getSilence = (id: string): Effect.Effect<SilenceRow, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const row = yield* db.first<SilenceRow>(
      `SELECT s.*, p.name AS project_name
       FROM silences s
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
      [id]
    )
    if (!row) return yield* Effect.fail(notFound("silence rule not found"))
    return row
  })

export const createSilence = (
  input: CreateSilenceInput
): Effect.Effect<SilenceRow, AppError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    if (!fields.has(input.field)) return yield* Effect.fail(invalid("silence field is invalid"))
    const value = input.value?.trim()
    if (!value || value.length > 500) {
      return yield* Effect.fail(invalid("silence value is required and must be at most 500 characters"))
    }

    if (input.project_id) {
      const project = yield* db.first<{ readonly id: string }>("SELECT id FROM projects WHERE id = ?", [input.project_id])
      if (!project) return yield* Effect.fail(notFound("project not found"))
    }

    const id = yield* newId("sil")
    yield* db.run(
      "INSERT INTO silences (id, project_id, field, value, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.project_id ?? null, input.field, value, input.note?.trim().slice(0, 1000) ?? "", nowIso()]
    )
    return yield* getSilence(id)
  })

export const deleteSilence = (id: string): Effect.Effect<void, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* getSilence(id)
    yield* db.run("DELETE FROM silences WHERE id = ?", [id])
  })

export const matchSilence = (
  projectId: string,
  candidates: ReadonlyArray<readonly [SilenceField, string]>
): Effect.Effect<string | null, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    for (const [field, value] of candidates) {
      if (!value) continue
      const row = yield* db.first<{ readonly id: string }>(
        `SELECT id FROM silences
         WHERE field = ? AND value = ? AND (project_id IS NULL OR project_id = ?)
         ORDER BY CASE WHEN project_id IS NULL THEN 1 ELSE 0 END
         LIMIT 1`,
        [field, value, projectId]
      )
      if (row) return row.id
    }
    return null
  })
