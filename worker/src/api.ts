import { Effect } from "effect"
import { SESSION_COOKIE, isAdmin, requireAdmin, requireProject } from "./auth.js"
import { randomToken, sha256Hex, verifyPasswordHash } from "./crypto.js"
import { appError, forbidden, invalid, notFound, unauthorized, type AppError } from "./errors.js"
import {
  createEventForProject,
  eventDeliveries,
  getEvent,
  listEvents,
  unsilenceEvent,
  type CreateEventInput
} from "./events.js"
import {
  errorResponse,
  jsonResponse,
  matchPath,
  noContent,
  parseCookies,
  readJson,
  serializeCookie
} from "./http.js"
import { nowIso } from "./ids.js"
import {
  createProject,
  deleteProject,
  findProjectRow,
  getProject,
  listProjects,
  rotateProjectKey,
  updateProject,
  type CreateProjectInput,
  type UpdateProjectInput
} from "./projects.js"
import {
  createSilence,
  deleteSilence,
  getSilence,
  listSilences,
  type CreateSilenceInput
} from "./silences.js"
import { AppConfig, Database, PushQueue } from "./services.js"
import { getSettings, updateSettings } from "./settings.js"
import {
  deleteSubscription,
  listSubscriptions,
  registerSubscription,
  updateSubscription,
  type RegisterSubscriptionInput
} from "./subscriptions.js"
import type { DeliveryRow, ProjectRow, SettingsView } from "./types.js"

export type ApiServices = Database | AppConfig | PushQueue

const requireSameOrigin = (request: Request): Effect.Effect<void, AppError> => {
  const origin = request.headers.get("origin")
  if (!origin) return Effect.void
  if (origin !== new URL(request.url).origin) {
    return Effect.fail(forbidden("cross-origin administrative requests are not allowed"))
  }
  return Effect.void
}

const guardAdmin = (
  request: Request,
  mutation = false
): Effect.Effect<void, AppError, Database | AppConfig> =>
  Effect.gen(function*() {
    yield* requireAdmin(request)
    if (mutation) yield* requireSameOrigin(request)
  })

const sessionCookie = (request: Request, token: string, maxAge: number): string =>
  serializeCookie(SESSION_COOKIE, token, {
    maxAge,
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(request.url).protocol === "https:"
  })

const authMe = (request: Request): Effect.Effect<Response, AppError, Database | AppConfig> =>
  Effect.map(isAdmin(request), (authenticated) =>
    jsonResponse({ auth_required: true, authenticated })
  )

const authLogin = (request: Request): Effect.Effect<Response, AppError, Database | AppConfig> =>
  Effect.gen(function*() {
    yield* requireSameOrigin(request)
    const input = yield* readJson<{ readonly username?: string; readonly password?: string }>(request)
    const config = yield* AppConfig
    const validInput = typeof input.username === "string" && input.username.length <= 120 &&
      typeof input.password === "string" && input.password.length <= 1_024
    const validPassword = validInput
      ? yield* verifyPasswordHash(input.password!, config.adminPasswordHash)
      : false
    if (input.username !== config.adminUser || !validPassword) {
      return yield* Effect.fail(appError(401, "bad_credentials", "wrong username or password"))
    }

    const db = yield* Database
    const token = randomToken(32)
    const tokenHash = yield* sha256Hex(token)
    const now = nowIso()
    const expires = new Date(Date.now() + 30 * 86_400_000).toISOString()
    yield* db.run(
      "INSERT INTO admin_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)",
      [tokenHash, expires, now]
    )

    return jsonResponse(
      { auth_required: true, authenticated: true },
      200,
      { "set-cookie": sessionCookie(request, token, 30 * 86_400) }
    )
  })

const authLogout = (request: Request): Effect.Effect<Response, AppError, Database> =>
  Effect.gen(function*() {
    yield* requireSameOrigin(request)
    const token = parseCookies(request)[SESSION_COOKIE]
    if (token) {
      const db = yield* Database
      const hash = yield* sha256Hex(token)
      yield* db.run("DELETE FROM admin_sessions WHERE token_hash = ?", [hash])
    }
    return noContent({
      "set-cookie": serializeCookie(SESSION_COOKIE, "", {
        maxAge: 0,
        expires: new Date(0),
        secure: new URL(request.url).protocol === "https:"
      })
    })
  })

const health = (): Effect.Effect<Response, AppError, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* db.first<{ readonly ok: number }>("SELECT 1 AS ok")
    return jsonResponse({ status: "ok" })
  })

const status = (request: Request): Effect.Effect<Response, AppError, Database | AppConfig> =>
  Effect.gen(function*() {
    yield* guardAdmin(request)
    const db = yield* Database
    const config = yield* AppConfig
    const counts = yield* db.first<{
      readonly projects: number
      readonly events: number
      readonly subscriptions: number
      readonly enabled_subscriptions: number
    }>(
      `SELECT
         (SELECT COUNT(*) FROM projects) AS projects,
         (SELECT COUNT(*) FROM events) AS events,
         (SELECT COUNT(*) FROM push_subscriptions) AS subscriptions,
         (SELECT COUNT(*) FROM push_subscriptions WHERE enabled = 1) AS enabled_subscriptions`
    )
    const lastPush = yield* db.first<DeliveryRow>(
      `SELECT d.id, d.event_id, d.subscription_id,
              COALESCE(s.name, '') AS subscription_name,
              d.status, d.response_status, d.error, d.attempted_at
       FROM deliveries d
       LEFT JOIN push_subscriptions s ON s.id = d.subscription_id
       ORDER BY d.attempted_at DESC LIMIT 1`
    )
    const settings = yield* getSettings

    return jsonResponse({
      version: "0.1.0",
      server: "ops-context/effect-v4/cloudflare-workers",
      database: "Cloudflare D1",
      base_url: config.baseUrl ?? new URL(request.url).origin,
      uptime_seconds: null,
      web_push: {
        configured: Boolean(config.vapidPublicKey && config.vapidPrivateJwk && config.vapidSubject),
        subject: config.vapidSubject
      },
      projects: counts?.projects ?? 0,
      events: counts?.events ?? 0,
      subscriptions: counts?.subscriptions ?? 0,
      enabled_subscriptions: counts?.enabled_subscriptions ?? 0,
      last_push: lastPush,
      retention_days: settings.retention_days,
      setup_completed: settings.setup_completed,
      admin_auth: true
    })
  })

const listSilencesResponse = (request: Request): Effect.Effect<Response, AppError, Database | AppConfig> =>
  Effect.gen(function*() {
    yield* guardAdmin(request)
    const db = yield* Database
    const silences = yield* listSilences
    const count = yield* db.first<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM events WHERE silence_id IS NOT NULL"
    )
    return jsonResponse({
      silences,
      fields: ["fingerprint", "title", "source"],
      silenced_events: count?.count ?? 0
    })
  })

const testNotification = (request: Request): Effect.Effect<Response, AppError, ApiServices> =>
  Effect.gen(function*() {
    yield* guardAdmin(request, true)
    const input = yield* readJson<{ readonly project_id?: string }>(request, { optional: true })
    const db = yield* Database
    const config = yield* AppConfig
    const selected: ProjectRow | null = input.project_id
      ? yield* findProjectRow(input.project_id)
      : yield* db.first<ProjectRow>("SELECT * FROM projects ORDER BY created_at LIMIT 1")
    if (!selected) return yield* Effect.fail(notFound("create a project before sending a test notification"))

    const event = yield* createEventForProject(selected, {
      title: "Ops Context is connected",
      body: "Web Push delivery is working.",
      level: "success",
      source: "ops-context",
      type: "test",
      fingerprint: "ops-context-test",
      data: { test: true }
    })
    return jsonResponse({ event, web_push_configured: Boolean(config.vapidPublicKey && config.vapidPrivateJwk && config.vapidSubject) }, 201)
  })

const routeNotFound = (): Effect.Effect<Response, AppError> =>
  Effect.fail(notFound("no such endpoint"))

export const handleApi = (request: Request): Effect.Effect<Response, AppError, ApiServices> => {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  const path = url.pathname

  if (method === "GET" && path === "/health") return health()
  if (method === "GET" && path === "/api/v1/auth/me") return authMe(request)
  if (method === "POST" && path === "/api/v1/auth/login") return authLogin(request)
  if (method === "POST" && path === "/api/v1/auth/logout") return authLogout(request)

  if (method === "GET" && path === "/api/v1/push/public-key") {
    return Effect.gen(function*() {
      const config = yield* AppConfig
      if (!config.vapidPublicKey) {
        return yield* Effect.fail(appError(503, "push_not_configured", "Web Push is not configured"))
      }
      return jsonResponse({ public_key: config.vapidPublicKey })
    })
  }

  if (method === "POST" && path === "/api/v1/events") {
    return Effect.gen(function*() {
      const project = yield* requireProject(request)
      const input = yield* readJson<CreateEventInput>(request)
      const event = yield* createEventForProject(project, input)
      return jsonResponse({ id: event.id, created_at: event.created_at }, 201)
    })
  }

  if (method === "GET" && path === "/api/v1/events") {
    return Effect.gen(function*() {
      yield* guardAdmin(request)
      const project = url.searchParams.get("project")
      const level = url.searchParams.get("level")
      const source = url.searchParams.get("source")
      const silenced = url.searchParams.get("silenced")
      const before = url.searchParams.get("before")
      const limit = url.searchParams.get("limit")
      const page = yield* listEvents({
        ...(project ? { project } : {}),
        ...(level ? { level } : {}),
        ...(source ? { source } : {}),
        ...(silenced ? { silenced } : {}),
        ...(before ? { before } : {}),
        ...(limit ? { limit } : {})
      })
      return jsonResponse(page)
    })
  }

  const deliveriesMatch = matchPath("/api/v1/events/:id/deliveries", path)
  if (method === "GET" && deliveriesMatch) {
    const eventId = deliveriesMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request)
      return jsonResponse({ deliveries: yield* eventDeliveries(eventId) })
    })
  }

  const unsilenceMatch = matchPath("/api/v1/events/:id/unsilence", path)
  if (method === "POST" && unsilenceMatch) {
    const eventId = unsilenceMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      return jsonResponse(yield* unsilenceEvent(eventId))
    })
  }

  const eventMatch = matchPath("/api/v1/events/:id", path)
  if (method === "GET" && eventMatch) {
    const eventId = eventMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request)
      return jsonResponse(yield* getEvent(eventId))
    })
  }

  if (method === "GET" && path === "/api/v1/projects") {
    return Effect.gen(function*() {
      yield* guardAdmin(request)
      return jsonResponse({ projects: yield* listProjects })
    })
  }

  if (method === "GET" && path === "/api/v1/projects/icons") {
    return Effect.gen(function*() {
      yield* guardAdmin(request)
      return jsonResponse({ icons: ["", "🚀", "🗄️", "💳", "🛡️", "📦", "⚙️", "🧪", "📈", "🔔"] })
    })
  }

  if (method === "POST" && path === "/api/v1/projects") {
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      const input = yield* readJson<CreateProjectInput>(request)
      return jsonResponse(yield* createProject(input), 201)
    })
  }

  const rotateProjectMatch = matchPath("/api/v1/projects/:id/rotate-key", path)
  if (method === "POST" && rotateProjectMatch) {
    const projectId = rotateProjectMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      return jsonResponse(yield* rotateProjectKey(projectId))
    })
  }

  const projectMatch = matchPath("/api/v1/projects/:id", path)
  if (projectMatch && method === "GET") {
    const projectId = projectMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request)
      return jsonResponse(yield* getProject(projectId))
    })
  }
  if (projectMatch && method === "PATCH") {
    const projectId = projectMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      const patch = yield* readJson<UpdateProjectInput>(request)
      return jsonResponse(yield* updateProject(projectId, patch))
    })
  }
  if (projectMatch && method === "DELETE") {
    const projectId = projectMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      yield* deleteProject(projectId)
      return noContent()
    })
  }

  if (method === "GET" && path === "/api/v1/push/subscriptions") {
    return Effect.gen(function*() {
      yield* guardAdmin(request)
      return jsonResponse({ subscriptions: yield* listSubscriptions })
    })
  }

  if (method === "POST" && path === "/api/v1/push/subscriptions") {
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      const input = yield* readJson<RegisterSubscriptionInput>(request)
      const subscription = yield* registerSubscription(input, request.headers.get("user-agent") ?? "")
      return jsonResponse(subscription, 201)
    })
  }

  const subscriptionMatch = matchPath("/api/v1/push/subscriptions/:id", path)
  if (subscriptionMatch && method === "PATCH") {
    const subscriptionId = subscriptionMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      const patch = yield* readJson<{ readonly name?: string; readonly enabled?: boolean }>(request)
      return jsonResponse(yield* updateSubscription(subscriptionId, patch))
    })
  }
  if (subscriptionMatch && method === "DELETE") {
    const subscriptionId = subscriptionMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      yield* deleteSubscription(subscriptionId)
      return noContent()
    })
  }

  if (method === "GET" && path === "/api/v1/silences") return listSilencesResponse(request)
  if (method === "POST" && path === "/api/v1/silences") {
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      const input = yield* readJson<CreateSilenceInput>(request)
      return jsonResponse(yield* createSilence(input), 201)
    })
  }

  const silenceMatch = matchPath("/api/v1/silences/:id", path)
  if (silenceMatch && method === "GET") {
    const silenceId = silenceMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request)
      return jsonResponse(yield* getSilence(silenceId))
    })
  }
  if (silenceMatch && method === "DELETE") {
    const silenceId = silenceMatch.params.id!
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      yield* deleteSilence(silenceId)
      return noContent()
    })
  }

  if (method === "GET" && path === "/api/v1/settings") {
    return Effect.gen(function*() {
      yield* guardAdmin(request)
      return jsonResponse(yield* getSettings)
    })
  }
  if (method === "PATCH" && path === "/api/v1/settings") {
    return Effect.gen(function*() {
      yield* guardAdmin(request, true)
      const patch = yield* readJson<Partial<SettingsView>>(request)
      return jsonResponse(yield* updateSettings(patch))
    })
  }

  if (method === "GET" && path === "/api/v1/status") return status(request)
  if (method === "POST" && path === "/api/v1/test") return testNotification(request)

  return routeNotFound()
}

export const handleApiSafely = (request: Request): Effect.Effect<Response, never, ApiServices> =>
  handleApi(request).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))))
