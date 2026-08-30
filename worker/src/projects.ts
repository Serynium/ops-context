import { Effect } from "effect"
import {
  invalidProject,
  invalidProjectCredential,
  projectDeletionConflict,
  projectNotFound,
  type CryptographyUnavailable,
  type InvalidProject,
  type InvalidProjectCredential,
  type ProjectDeletionConflict,
  type ProjectNotFound,
  type RepositoryUnavailable
} from "./errors.js"
import { randomToken, sha256Hex } from "./crypto.js"
import { newId, nowIso } from "./ids.js"
import { isLevel } from "./levels.js"
import { CredentialCrypto, Database } from "./services.js"
import type { Level, ProjectRow, ProjectView } from "./types.js"

export interface CreateProjectInput {
  readonly name: string
  readonly icon?: string | undefined
}

export interface UpdateProjectInput {
  readonly name?: string | undefined
  readonly icon?: string | undefined
  readonly notify?: boolean | undefined
  readonly min_level?: Level | undefined
}

export type ProjectError = RepositoryUnavailable | CryptographyUnavailable |
  ProjectNotFound | InvalidProjectCredential | InvalidProject | ProjectDeletionConflict

const toView = (row: ProjectRow): ProjectView => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  icon: row.icon,
  notify: row.notify === 1,
  min_level: row.min_level,
  created_at: row.created_at,
  updated_at: row.updated_at
})

const slugify = (name: string): string => {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
  return slug || "project"
}

export const listProjects: Effect.Effect<ReadonlyArray<ProjectView>, RepositoryUnavailable, Database> =
  Effect.gen(function*() {
    const db = yield* Database
    const rows = yield* db.all<ProjectRow>("projects.list", "SELECT * FROM projects ORDER BY name COLLATE NOCASE")
    return rows.map(toView)
  })

export const findProjectRow = (id: string): Effect.Effect<ProjectRow, ProjectNotFound | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const row = yield* db.first<ProjectRow>("projects.get_by_id", "SELECT * FROM projects WHERE id = ?", [id])
    if (!row) return yield* Effect.fail(projectNotFound())
    return row
  })

export const getProject = (id: string): Effect.Effect<ProjectView, ProjectNotFound | RepositoryUnavailable, Database> =>
  Effect.map(findProjectRow(id), toView)

export const authenticateProject = (apiKey: string): Effect.Effect<ProjectRow, InvalidProjectCredential | RepositoryUnavailable | CryptographyUnavailable, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    const hash = yield* sha256Hex(apiKey)
    const project = yield* db.first<ProjectRow>("projects.get_by_api_key_hash", "SELECT * FROM projects WHERE api_key_hash = ?", [hash])
    if (!project) return yield* Effect.fail(invalidProjectCredential())
    return project
  })

export const createProject = (
  input: CreateProjectInput
): Effect.Effect<ProjectView & { readonly api_key: string }, ProjectError, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    const name = input.name?.trim()
    if (!name || name.length > 120) {
      return yield* Effect.fail(invalidProject("project name is required and must be at most 120 characters"))
    }

    const id = yield* newId("prj")
    const createdAt = nowIso()
    const apiKey = `ops_proj_${yield* randomToken(32)}`
    const apiKeyHash = yield* sha256Hex(apiKey)
    const baseSlug = slugify(name)
    let slug = baseSlug
    const existing = yield* db.first<{ readonly id: string }>("projects.get_by_slug", "SELECT id FROM projects WHERE slug = ?", [slug])
    if (existing) slug = `${baseSlug.slice(0, 40)}-${id.slice(-6)}`

    yield* db.run(
      "projects.create",
      `INSERT INTO projects
       (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'info', ?, ?)`,
      [id, name, slug, input.icon?.trim().slice(0, 16) ?? "", apiKeyHash, createdAt, createdAt]
    )

    const row = yield* findProjectRow(id)
    return { ...toView(row), api_key: apiKey }
  })

export const updateProject = (
  id: string,
  patch: UpdateProjectInput
): Effect.Effect<ProjectView, InvalidProject | ProjectNotFound | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    const current = yield* findProjectRow(id)
    const name = patch.name === undefined ? current.name : patch.name.trim()
    if (!name || name.length > 120) return yield* Effect.fail(invalidProject("project name is invalid"))
    if (patch.min_level !== undefined && !isLevel(patch.min_level)) {
      return yield* Effect.fail(invalidProject("min_level is invalid"))
    }

    const icon = patch.icon === undefined ? current.icon : patch.icon.trim().slice(0, 16)
    const notify = patch.notify === undefined ? current.notify : patch.notify ? 1 : 0
    const minLevel = patch.min_level ?? current.min_level

    yield* db.run(
      "projects.update",
      `UPDATE projects SET name = ?, icon = ?, notify = ?, min_level = ?, updated_at = ? WHERE id = ?`,
      [name, icon, notify, minLevel, nowIso(), id]
    )
    return yield* getProject(id)
  })

export const deleteProject = (id: string): Effect.Effect<void, ProjectNotFound | ProjectDeletionConflict | RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* findProjectRow(id)
    const count = yield* db.first<{ readonly count: number }>(
      "projects.count",
      "SELECT COUNT(*) AS count FROM projects"
    )
    if ((count?.count ?? 0) <= 1) {
      return yield* Effect.fail(projectDeletionConflict("the last project cannot be deleted"))
    }
    yield* db.run("projects.delete", "DELETE FROM projects WHERE id = ?", [id])
  })

export const rotateProjectKey = (
  id: string
): Effect.Effect<ProjectView & { readonly api_key: string }, ProjectNotFound | RepositoryUnavailable | CryptographyUnavailable, Database | CredentialCrypto> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* findProjectRow(id)
    const apiKey = `ops_proj_${yield* randomToken(32)}`
    const hash = yield* sha256Hex(apiKey)
    yield* db.run("projects.rotate_api_key", "UPDATE projects SET api_key_hash = ?, updated_at = ? WHERE id = ?", [hash, nowIso(), id])
    const project = yield* getProject(id)
    return { ...project, api_key: apiKey }
  })
