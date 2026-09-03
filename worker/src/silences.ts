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
import { ProjectsRepository, SilencesRepository, type SilenceRow } from "./repositories.js"
import { CredentialCrypto } from "./services.js"

export type SilenceField = "fingerprint" | "title" | "source"

export interface CreateSilenceInput {
  readonly project_id?: string | undefined
  readonly field: SilenceField
  readonly value: string
  readonly note?: string | undefined
}

const fields = new Set<SilenceField>(["fingerprint", "title", "source"])

export const listSilences: Effect.Effect<ReadonlyArray<SilenceRow>, RepositoryUnavailable, SilencesRepository> =
  Effect.gen(function*() {
    const silences = yield* SilencesRepository
    return yield* silences.list
  })

export const getSilence = (id: string): Effect.Effect<SilenceRow, SilenceNotFound | RepositoryUnavailable, SilencesRepository> =>
  Effect.gen(function*() {
    const silences = yield* SilencesRepository
    const row = yield* silences.findById(id)
    if (!row) return yield* Effect.fail(silenceNotFound())
    return row
  })

export const createSilence = (
  input: CreateSilenceInput
): Effect.Effect<SilenceRow, InvalidSilence | ProjectNotFound | SilenceNotFound | RepositoryUnavailable | CryptographyUnavailable, SilencesRepository | ProjectsRepository | CredentialCrypto> =>
  Effect.gen(function*() {
    const silences = yield* SilencesRepository
    const projects = yield* ProjectsRepository
    if (!fields.has(input.field)) return yield* Effect.fail(invalidSilence("silence field is invalid"))
    const value = input.value?.trim()
    if (!value || value.length > 500) {
      return yield* Effect.fail(invalidSilence("silence value is required and must be at most 500 characters"))
    }

    if (input.project_id) {
      const project = yield* projects.findById(input.project_id)
      if (!project) return yield* Effect.fail(projectNotFound())
    }

    const id = yield* newId("sil")
    yield* silences.insert({ id, projectId: input.project_id ?? null, field: input.field, value,
      note: input.note?.trim().slice(0, 1000) ?? "", createdAt: nowIso() })
    return yield* getSilence(id)
  })

export const deleteSilence = (id: string): Effect.Effect<void, SilenceNotFound | RepositoryUnavailable, SilencesRepository> =>
  Effect.gen(function*() {
    const silences = yield* SilencesRepository
    yield* getSilence(id)
    yield* silences.delete(id)
  })

export const matchSilence = (
  projectId: string,
  candidates: ReadonlyArray<readonly [SilenceField, string]>
): Effect.Effect<string | null, RepositoryUnavailable, SilencesRepository> =>
  Effect.gen(function*() {
    const silences = yield* SilencesRepository
    return yield* silences.findMatch(projectId, candidates)
  })
