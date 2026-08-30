import { Effect } from "effect"
import {
  invalidSilence,
  projectNotFound,
  silenceNotFound,
  type CryptographyUnavailable,
  type InvalidSilence,
  type ProjectNotFound,
  type RepositoryUnavailable,
  type SilenceNotFound
} from "./errors.js"
import { newId, nowIso } from "./ids.js"
import { CredentialCrypto, Database } from "./services.js"
import type { SilenceRow } from "./types.js"

export type SilenceField = "fingerprint" | "title" | "source"

export interface CreateSilenceInput {
  readonly project_id?: string | undefined
  readonly field: SilenceField
  readonly value: string
  readonly note?: string | undefined
}

const fields = new Set<SilenceField>(["fingerprint", "title", "source"])

export const listSilences: Effect.Effect<ReadonlyArray<SilenceRow>, RepositoryUnavailable, Database> =
  Effect.gen(function*() {
    const db = yield* Database
    return yield* db.all<SilenceRow>(
      "silences.list",
      `SELECT s.*, p.name AS project_name
       FROM silences s
       LEFT JOIN projects p ON p.id = s.project_id
       ORDER BY s.created_at DESC`
    )
  })

export const getSilence = (id: string): Effect.Effect<SilenceRow, SilenceNotFound | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const row = yield* db.first<SilenceRow>(
      "silences.get_by_id",
      `SELECT s.*, p.name AS project_name
       FROM silences s
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
      [id]
    )
    if (!row) return yield* Effect.fail(silenceNotFound())
    return row
  })

export const createSilence = (
  input: CreateSilenceInput
): Effect.Effect<SilenceRow, InvalidSilence | ProjectNotFound | SilenceNotFound | RepositoryUnavailable | CryptographyUnavailable, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    if (!fields.has(input.field)) return yield* Effect.fail(invalidSilence("silence field is invalid"))
    const value = input.value?.trim()
    if (!value || value.length > 500) {
      return yield* Effect.fail(invalidSilence("silence value is required and must be at most 500 characters"))
    }

    if (input.project_id) {
      const project = yield* db.first<{ readonly id: string }>("projects.exists_by_id", "SELECT id FROM projects WHERE id = ?", [input.project_id])
      if (!project) return yield* Effect.fail(projectNotFound())
    }

    const id = yield* newId("sil")
    yield* db.run(
      "silences.create",
      "INSERT INTO silences (id, project_id, field, value, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.project_id ?? null, input.field, value, input.note?.trim().slice(0, 1000) ?? "", nowIso()]
    )
    return yield* getSilence(id)
  })

export const deleteSilence = (id: string): Effect.Effect<void, SilenceNotFound | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* getSilence(id)
    yield* db.run("silences.delete", "DELETE FROM silences WHERE id = ?", [id])
  })

export const matchSilence = (
  projectId: string,
  candidates: ReadonlyArray<readonly [SilenceField, string]>
): Effect.Effect<string | null, RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const nonEmpty = candidates.filter((candidate) => candidate[1] !== "")
    if (nonEmpty.length === 0) return null

    const params: Array<string | number> = []
    const candidateRows = nonEmpty.map(([field, value], priority) => {
      params.push(field, value, priority)
      return "(?, ?, ?)"
    })
    params.push(projectId, projectId)

    const rows = yield* db.all<{ readonly id: string }>(
      "silences.match",
      `WITH candidates(field, value, priority) AS (
         VALUES ${candidateRows.join(", ")}
       )
       SELECT s.id
       FROM candidates c
       JOIN silences s ON s.field = c.field AND s.value = c.value
       WHERE s.project_id IS NULL OR s.project_id = ?
       ORDER BY c.priority, CASE WHEN s.project_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      params
    )
    return rows[0]?.id ?? null
  })
