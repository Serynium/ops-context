import { Effect } from "effect"
import { forbidden, unauthorized, type AppError } from "./errors.js"
import { getBearer, parseCookies } from "./http.js"
import { parseBasicCredentials, sha256Hex, verifyPasswordHash } from "./crypto.js"
import { AppConfig, Database } from "./services.js"
import { authenticateProject } from "./projects.js"
import type { ProjectRow } from "./types.js"

export const SESSION_COOKIE = "ops_session"

export const requireProject = (request: Request): Effect.Effect<ProjectRow, AppError, Database> =>
  Effect.gen(function*() {
    const key = getBearer(request)
    if (!key) return yield* Effect.fail(unauthorized("a project API key is required"))
    return yield* authenticateProject(key).pipe(
      Effect.catchAll(() => Effect.fail(unauthorized("invalid project API key")))
    )
  })

const checkSession = (request: Request): Effect.Effect<boolean, AppError, Database> =>
  Effect.gen(function*() {
    const token = parseCookies(request)[SESSION_COOKIE]
    if (!token) return false
    const db = yield* Database
    const tokenHash = yield* sha256Hex(token)
    const row = yield* db.first<{ readonly token_hash: string }>(
      "SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?",
      [tokenHash, new Date().toISOString()]
    )
    return row !== null
  })

const checkBasic = (request: Request): Effect.Effect<boolean, AppError, AppConfig> =>
  Effect.gen(function*() {
    const header = request.headers.get("authorization")
    if (!header?.startsWith("Basic ")) return false
    const config = yield* AppConfig
    const credentials = yield* parseBasicCredentials(header)
    if (credentials.username !== config.adminUser) return false
    return yield* verifyPasswordHash(credentials.password, config.adminPasswordHash)
  })

export const isAdmin = (request: Request): Effect.Effect<boolean, AppError, Database | AppConfig> =>
  Effect.gen(function*() {
    if (yield* checkSession(request)) return true
    return yield* checkBasic(request)
  })

export const requireAdmin = (request: Request): Effect.Effect<void, AppError, Database | AppConfig> =>
  Effect.gen(function*() {
    if (getBearer(request)) {
      return yield* Effect.fail(forbidden("project credentials cannot perform administrative actions"))
    }
    if (!(yield* isAdmin(request))) {
      return yield* Effect.fail(unauthorized("sign in to the Ops Context PWA"))
    }
  })
