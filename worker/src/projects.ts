import { Effect } from "effect"
import { base64UrlDecode, base64UrlEncode } from "./crypto.js"
import {
  invalidProject,
  invalidProjectCredential,
  projectNotFound,
  type CryptographyUnavailable,
  type InvalidProject,
  type InvalidProjectCredential,
  type ProjectNotFound,
  type RepositoryUnavailable
} from "./errors.js"
import { clamp, newId, nowIso } from "./ids.js"
import { isLevel } from "./levels.js"
import { ProjectsRepository, type ProjectRow } from "./repositories.js"
import { CredentialCrypto, randomToken, sha256Hex } from "./services.js"
import type { Level, ProjectView } from "./types.js"

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

export interface ProjectListInput {
  readonly before?: string | undefined
  readonly limit?: string | undefined
}

export interface ProjectPage {
  readonly projects: ReadonlyArray<ProjectView>
  readonly next_cursor?: string
}

export type ProjectError = RepositoryUnavailable | CryptographyUnavailable |
  ProjectNotFound | InvalidProjectCredential | InvalidProject

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

const cursorEncoder = new TextEncoder()
const cursorDecoder = new TextDecoder()

const encodeCursor = (row: ProjectRow): string =>
  base64UrlEncode(cursorEncoder.encode(JSON.stringify({ name: row.name, id: row.id })))

const decodeCursor = (value: string): { readonly name: string; readonly id: string } | null => {
  try {
    const parsed = JSON.parse(cursorDecoder.decode(base64UrlDecode(value))) as Record<string, unknown>
    return typeof parsed.name === "string" && parsed.name.length <= 120 &&
      typeof parsed.id === "string" && parsed.id.length <= 160
      ? { name: parsed.name, id: parsed.id }
      : null
  } catch {
    return null
  }
}

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

export const listProjects = (
  input: ProjectListInput
): Effect.Effect<ProjectPage, InvalidProject | RepositoryUnavailable, ProjectsRepository> =>
  Effect.gen(function*() {
    const projects = yield* ProjectsRepository
    const cursor = input.before ? decodeCursor(input.before) : null
    if (input.before && !cursor) return yield* Effect.fail(invalidProject("before cursor is invalid"))
    const requestedLimit = Number.parseInt(input.limit ?? "100", 10)
    const limit = clamp(Number.isFinite(requestedLimit) ? requestedLimit : 100, 1, 100)
    const rows = yield* projects.list({ ...(cursor ? { cursor } : {}), limit: limit + 1 })
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const last = pageRows.at(-1)
    return {
      projects: pageRows.map(toView),
      ...(hasMore && last ? { next_cursor: encodeCursor(last) } : {})
    }
  })

export const listAllProjects: Effect.Effect<ReadonlyArray<ProjectView>, InvalidProject | RepositoryUnavailable, ProjectsRepository> =
  Effect.gen(function*() {
    const result: ProjectView[] = []
    let before: string | undefined
    do {
      const page = yield* listProjects({ limit: "100", ...(before ? { before } : {}) })
      result.push(...page.projects)
      before = page.next_cursor
    } while (before)
    return result
  })

export const findProjectRow = (id: string): Effect.Effect<ProjectRow, ProjectNotFound | RepositoryUnavailable, ProjectsRepository> =>
  Effect.gen(function*() {
    const projects = yield* ProjectsRepository
    const row = yield* projects.findById(id)
    if (!row) return yield* Effect.fail(projectNotFound())
    return row
  })

export const getProject = (id: string): Effect.Effect<ProjectView, ProjectNotFound | RepositoryUnavailable, ProjectsRepository> =>
  Effect.map(findProjectRow(id), toView)

export const authenticateProject = (apiKey: string): Effect.Effect<ProjectRow, InvalidProjectCredential | RepositoryUnavailable | CryptographyUnavailable, ProjectsRepository | CredentialCrypto> =>
  Effect.gen(function*() {
    const projects = yield* ProjectsRepository
    const hash = yield* sha256Hex(apiKey)
    const project = yield* projects.findByApiKeyHash(hash)
    if (!project) return yield* Effect.fail(invalidProjectCredential())
    return project
  })

export const createProject = (
  input: CreateProjectInput
): Effect.Effect<ProjectView & { readonly api_key: string }, ProjectError, ProjectsRepository | CredentialCrypto> =>
  Effect.gen(function*() {
    const projects = yield* ProjectsRepository
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
    if (yield* projects.slugExists(slug)) slug = `${baseSlug.slice(0, 40)}-${id.slice(-6)}`

    yield* projects.insert({ id, name, slug, icon: input.icon?.trim().slice(0, 32) ?? "", apiKeyHash, createdAt })

    const row = yield* findProjectRow(id)
    return { ...toView(row), api_key: apiKey }
  })

export const updateProject = (
  id: string,
  patch: UpdateProjectInput
): Effect.Effect<ProjectView, InvalidProject | ProjectNotFound | RepositoryUnavailable, ProjectsRepository> =>
  Effect.gen(function*() {
    const projects = yield* ProjectsRepository
    const current = yield* findProjectRow(id)
    const name = patch.name === undefined ? current.name : patch.name.trim()
    if (!name || name.length > 120) return yield* Effect.fail(invalidProject("project name is invalid"))
    if (patch.min_level !== undefined && !isLevel(patch.min_level)) {
      return yield* Effect.fail(invalidProject("min_level is invalid"))
    }

    const icon = patch.icon === undefined ? current.icon : patch.icon.trim().slice(0, 32)
    const notify = patch.notify === undefined ? current.notify : patch.notify ? 1 : 0
    const minLevel = patch.min_level ?? current.min_level

    yield* projects.update(id, { name, icon, notify, minLevel, updatedAt: nowIso() })
    return yield* getProject(id)
  })

export const deleteProject = (id: string): Effect.Effect<void, ProjectNotFound | RepositoryUnavailable, ProjectsRepository> =>
  Effect.gen(function*() {
    const projects = yield* ProjectsRepository
    yield* findProjectRow(id)
    yield* projects.delete(id)
  })

export const rotateProjectKey = (
  id: string
): Effect.Effect<ProjectView & { readonly api_key: string }, ProjectNotFound | RepositoryUnavailable | CryptographyUnavailable, ProjectsRepository | CredentialCrypto> =>
  Effect.gen(function*() {
    const projects = yield* ProjectsRepository
    yield* findProjectRow(id)
    const apiKey = `ops_proj_${yield* randomToken(32)}`
    const hash = yield* sha256Hex(apiKey)
    yield* projects.rotateApiKey(id, hash, nowIso())
    const project = yield* getProject(id)
    return { ...project, api_key: apiKey }
  })
