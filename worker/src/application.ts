import { Context, Effect, Layer } from "effect"
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  Status as StatusSchema,
  UnauthorizedError,
  type ApiFailure,
  toApiFailure
} from "./api-models.js"
import { parseBasicCredentials } from "./crypto.js"
import {
  createEventForProject,
  eventDeliveries,
  getEvent,
  listEvents,
  unsilenceEvent,
  type CreateEventInput,
  type EventPage,
  type ListEventsInput
} from "./events.js"
import type { AppError } from "./errors.js"
import {
  authenticateProject,
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
import { processPushMessage, type PushOutcome } from "./push.js"
import {
  createSilence,
  deleteSilence,
  getSilence,
  listSilences,
  type CreateSilenceInput
} from "./silences.js"
import { getSettings, updateSettings, type SettingsPatch } from "./settings.js"
import {
  deleteSubscription,
  listSubscriptions,
  registerSubscription,
  updateSubscription,
  type RegisterSubscriptionInput
} from "./subscriptions.js"
import { runMaintenance, type MaintenanceResult } from "./maintenance.js"
import {
  AppConfig,
  CredentialCrypto,
  Database,
  PasswordHasher,
  PushQueue,
  WebPush
} from "./services.js"
import type {
  DeliveryRow,
  EventView,
  ProjectRow,
  ProjectView,
  PushJobMessage,
  PushSubscriptionView,
  SettingsView,
  SilenceRow
} from "./types.js"

const mapAppError = <A, R>(effect: Effect.Effect<A, AppError, R>): Effect.Effect<A, ApiFailure, R> =>
  Effect.mapError(effect, toApiFailure)

const provideAll = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  context: Context.Context<R>
): Effect.Effect<A, E> => Effect.provideContext(effect, context)

export class Projects extends Context.Service<Projects, {
  readonly list: Effect.Effect<ReadonlyArray<ProjectView>, ApiFailure>
  readonly get: (id: string) => Effect.Effect<ProjectView, ApiFailure>
  readonly findRow: (id: string) => Effect.Effect<ProjectRow, ApiFailure>
  readonly firstRow: Effect.Effect<ProjectRow | null, ApiFailure>
  readonly authenticate: (apiKey: string) => Effect.Effect<ProjectRow, ApiFailure>
  readonly create: (input: CreateProjectInput) => Effect.Effect<ProjectView & { readonly api_key: string }, ApiFailure>
  readonly update: (id: string, patch: UpdateProjectInput) => Effect.Effect<ProjectView, ApiFailure>
  readonly delete: (id: string) => Effect.Effect<void, ApiFailure>
  readonly rotateKey: (id: string) => Effect.Effect<ProjectView & { readonly api_key: string }, ApiFailure>
}>()("ops-context/Projects") {
  static readonly layer = Layer.effect(
    Projects,
    Effect.gen(function*() {
      const context = yield* Effect.context<Database | CredentialCrypto>()
      const database = Context.get(context, Database)
      const run = <A>(effect: Effect.Effect<A, AppError, Database | CredentialCrypto>) =>
        mapAppError(provideAll(effect, context))
      const runDb = <A>(effect: Effect.Effect<A, AppError, Database>) =>
        mapAppError(Effect.provideService(effect, Database, database))

      return Projects.of({
        list: runDb(listProjects).pipe(Effect.withSpan("Projects.list")),
        get: Effect.fn("Projects.get")((id: string) => runDb(getProject(id))),
        findRow: Effect.fn("Projects.findRow")((id: string) => runDb(findProjectRow(id))),
        firstRow: mapAppError(database.first<ProjectRow>("SELECT * FROM projects ORDER BY created_at LIMIT 1")),
        authenticate: Effect.fn("Projects.authenticate")((apiKey: string) => run(authenticateProject(apiKey))),
        create: Effect.fn("Projects.create")((input: CreateProjectInput) => run(createProject(input))),
        update: Effect.fn("Projects.update")((id: string, patch: UpdateProjectInput) => runDb(updateProject(id, patch))),
        delete: Effect.fn("Projects.delete")((id: string) => runDb(deleteProject(id))),
        rotateKey: Effect.fn("Projects.rotateKey")((id: string) => run(rotateProjectKey(id)))
      })
    })
  )
}

export class Events extends Context.Service<Events, {
  readonly create: (project: ProjectRow, input: CreateEventInput) => Effect.Effect<EventView, ApiFailure>
  readonly list: (input: ListEventsInput) => Effect.Effect<EventPage, ApiFailure>
  readonly get: (id: string) => Effect.Effect<EventView, ApiFailure>
  readonly deliveries: (id: string) => Effect.Effect<ReadonlyArray<DeliveryRow>, ApiFailure>
  readonly unsilence: (id: string) => Effect.Effect<{
    readonly event: EventView
    readonly deliveries: ReadonlyArray<DeliveryRow>
  }, ApiFailure>
}>()("ops-context/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function*() {
      const context = yield* Effect.context<Database | PushQueue | AppConfig | CredentialCrypto>()
      const run = <A>(effect: Effect.Effect<A, AppError, Database | PushQueue | AppConfig | CredentialCrypto>) =>
        mapAppError(provideAll(effect, context))
      const database = Context.get(context, Database)
      const queue = Context.get(context, PushQueue)

      return Events.of({
        create: Effect.fn("Events.create")((project: ProjectRow, input: CreateEventInput) =>
          run(createEventForProject(project, input))),
        list: Effect.fn("Events.list")((input: ListEventsInput) =>
          mapAppError(Effect.provideService(listEvents(input), Database, database))),
        get: Effect.fn("Events.get")((id: string) =>
          mapAppError(Effect.provideService(getEvent(id), Database, database))),
        deliveries: Effect.fn("Events.deliveries")((id: string) =>
          mapAppError(Effect.provideService(eventDeliveries(id), Database, database))),
        unsilence: Effect.fn("Events.unsilence")((id: string) =>
          mapAppError(
            unsilenceEvent(id).pipe(
              Effect.provideService(Database, database),
              Effect.provideService(PushQueue, queue)
            )
          ))
      })
    })
  )
}

export class Subscriptions extends Context.Service<Subscriptions, {
  readonly list: Effect.Effect<ReadonlyArray<PushSubscriptionView>, ApiFailure>
  readonly register: (input: RegisterSubscriptionInput, userAgent: string) => Effect.Effect<PushSubscriptionView, ApiFailure>
  readonly update: (
    id: string,
    patch: { readonly name?: string | undefined; readonly enabled?: boolean | undefined }
  ) => Effect.Effect<PushSubscriptionView, ApiFailure>
  readonly delete: (id: string) => Effect.Effect<void, ApiFailure>
}>()("ops-context/Subscriptions") {
  static readonly layer = Layer.effect(
    Subscriptions,
    Effect.gen(function*() {
      const context = yield* Effect.context<Database | CredentialCrypto>()
      const database = Context.get(context, Database)
      return Subscriptions.of({
        list: mapAppError(Effect.provideService(listSubscriptions, Database, database)),
        register: Effect.fn("Subscriptions.register")((input: RegisterSubscriptionInput, userAgent: string) =>
          mapAppError(provideAll(registerSubscription(input, userAgent), context))),
        update: Effect.fn("Subscriptions.update")((id: string, patch: { readonly name?: string | undefined; readonly enabled?: boolean | undefined }) =>
          mapAppError(Effect.provideService(updateSubscription(id, patch), Database, database))),
        delete: Effect.fn("Subscriptions.delete")((id: string) =>
          mapAppError(Effect.provideService(deleteSubscription(id), Database, database)))
      })
    })
  )
}

export class Silences extends Context.Service<Silences, {
  readonly list: Effect.Effect<ReadonlyArray<SilenceRow>, ApiFailure>
  readonly listSummary: Effect.Effect<{
    readonly silences: ReadonlyArray<SilenceRow>
    readonly fields: ReadonlyArray<"fingerprint" | "title" | "source">
    readonly silenced_events: number
  }, ApiFailure>
  readonly get: (id: string) => Effect.Effect<SilenceRow, ApiFailure>
  readonly create: (input: CreateSilenceInput) => Effect.Effect<SilenceRow, ApiFailure>
  readonly delete: (id: string) => Effect.Effect<void, ApiFailure>
}>()("ops-context/Silences") {
  static readonly layer = Layer.effect(
    Silences,
    Effect.gen(function*() {
      const context = yield* Effect.context<Database | CredentialCrypto>()
      const database = Context.get(context, Database)
      const list = mapAppError(Effect.provideService(listSilences, Database, database))
      return Silences.of({
        list,
        listSummary: Effect.gen(function*() {
          const silences = yield* list
          const count = yield* mapAppError(database.first<{ readonly count: number }>(
            "SELECT COUNT(*) AS count FROM events WHERE silence_id IS NOT NULL"
          ))
          return {
            silences,
            fields: ["fingerprint", "title", "source"] as const,
            silenced_events: count?.count ?? 0
          }
        }).pipe(Effect.withSpan("Silences.listSummary")),
        get: Effect.fn("Silences.get")((id: string) =>
          mapAppError(Effect.provideService(getSilence(id), Database, database))),
        create: Effect.fn("Silences.create")((input: CreateSilenceInput) =>
          mapAppError(provideAll(createSilence(input), context))),
        delete: Effect.fn("Silences.delete")((id: string) =>
          mapAppError(Effect.provideService(deleteSilence(id), Database, database)))
      })
    })
  )
}

export class Settings extends Context.Service<Settings, {
  readonly get: Effect.Effect<SettingsView, ApiFailure>
  readonly update: (patch: SettingsPatch) => Effect.Effect<SettingsView, ApiFailure>
}>()("ops-context/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const context = yield* Effect.context<Database | AppConfig>()
      return Settings.of({
        get: mapAppError(provideAll(getSettings, context)).pipe(Effect.withSpan("Settings.get")),
        update: Effect.fn("Settings.update")((patch: SettingsPatch) =>
          mapAppError(provideAll(updateSettings(patch), context)))
      })
    })
  )
}

export interface AuthState {
  readonly auth_required: true
  readonly authenticated: boolean
}

export class Auth extends Context.Service<Auth, {
  readonly me: (request: HttpServerRequest) => Effect.Effect<AuthState, ApiFailure>
  readonly requireAdmin: (request: HttpServerRequest) => Effect.Effect<void, ApiFailure>
  readonly requireSameOrigin: (request: HttpServerRequest) => Effect.Effect<void, ApiFailure>
  readonly login: (
    request: HttpServerRequest,
    input: { readonly username: string; readonly password: string }
  ) => Effect.Effect<{ readonly state: AuthState; readonly cookie: string }, ApiFailure>
  readonly logout: (request: HttpServerRequest) => Effect.Effect<string, ApiFailure>
}>()("ops-context/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function*() {
      const database = yield* Database
      const config = yield* AppConfig
      const credentialCrypto = yield* CredentialCrypto
      const passwordHasher = yield* PasswordHasher
      const sessionCookie = "ops_session"

      const originOf = (request: HttpServerRequest): string => {
        const protocol = request.headers["x-forwarded-proto"] ?? "https"
        const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost"
        return `${protocol}://${host}`
      }

      const cookie = (
        request: HttpServerRequest,
        token: string,
        maxAge: number,
        expires?: Date
      ): string => {
        const parts = [`${sessionCookie}=${encodeURIComponent(token)}`, "Path=/", `Max-Age=${Math.floor(maxAge)}`, "HttpOnly", "SameSite=Lax"]
        if ((request.headers["x-forwarded-proto"] ?? "https") === "https") parts.push("Secure")
        if (expires) parts.push(`Expires=${expires.toUTCString()}`)
        return parts.join("; ")
      }

      const checkSession = Effect.fn("Auth.checkSession")(function*(request: HttpServerRequest) {
        const token = request.cookies[sessionCookie]
        if (!token) return false
        const tokenHash = yield* credentialCrypto.sha256Hex(token).pipe(Effect.mapError(toApiFailure))
        const row = yield* database.first<{ readonly token_hash: string }>(
          "SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?",
          [tokenHash, new Date().toISOString()]
        ).pipe(Effect.mapError(toApiFailure))
        return row !== null
      })

      const checkBasic = Effect.fn("Auth.checkBasic")(function*(request: HttpServerRequest) {
        const header = request.headers.authorization
        if (!header?.startsWith("Basic ")) return false
        const credentials = yield* parseBasicCredentials(header).pipe(
          Effect.catch(() => Effect.succeed({ username: "", password: "" }))
        )
        if (credentials.username !== config.adminUser) return false
        return yield* passwordHasher.verify(credentials.password, config.adminPasswordHash).pipe(
          Effect.mapError(toApiFailure)
        )
      })

      const isAdmin = Effect.fn("Auth.isAdmin")(function*(request: HttpServerRequest) {
        if (yield* checkSession(request)) return true
        return yield* checkBasic(request)
      })

      const requireSameOrigin = Effect.fn("Auth.requireSameOrigin")(function*(request: HttpServerRequest) {
        const origin = request.headers.origin
        if (!origin) return
        const expected = config.baseUrl ? new URL(config.baseUrl).origin : originOf(request)
        if (origin !== expected) {
          return yield* new ForbiddenError({
            error: "forbidden",
            message: "cross-origin administrative requests are not allowed"
          })
        }
      })

      const requireAdmin = Effect.fn("Auth.requireAdmin")(function*(request: HttpServerRequest) {
        if (request.headers.authorization?.startsWith("Bearer ")) {
          return yield* new ForbiddenError({
            error: "forbidden",
            message: "project credentials cannot perform administrative actions"
          })
        }
        if (!(yield* isAdmin(request))) {
          return yield* new UnauthorizedError({
            error: "unauthorized",
            message: "sign in to the Ops Context PWA"
          })
        }
      })

      const login = Effect.fn("Auth.login")(function*(
        request: HttpServerRequest,
        input: { readonly username: string; readonly password: string }
      ) {
        yield* requireSameOrigin(request)
        const validInput = input.username.length <= 120 && input.password.length <= 1_024
        const validPassword = validInput
          ? yield* passwordHasher.verify(input.password, config.adminPasswordHash).pipe(Effect.mapError(toApiFailure))
          : false
        if (input.username !== config.adminUser || !validPassword) {
          return yield* new UnauthorizedError({ error: "bad_credentials", message: "wrong username or password" })
        }

        const token = yield* credentialCrypto.randomToken(32).pipe(Effect.mapError(toApiFailure))
        const tokenHash = yield* credentialCrypto.sha256Hex(token).pipe(Effect.mapError(toApiFailure))
        const now = new Date().toISOString()
        const maxAge = 30 * 86_400
        const expires = new Date(Date.now() + maxAge * 1_000)
        yield* database.run(
          "INSERT INTO admin_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)",
          [tokenHash, expires.toISOString(), now]
        ).pipe(Effect.mapError(toApiFailure))

        return {
          state: { auth_required: true, authenticated: true } as const,
          cookie: cookie(request, token, maxAge)
        }
      })

      const logout = Effect.fn("Auth.logout")(function*(request: HttpServerRequest) {
        yield* requireSameOrigin(request)
        const token = request.cookies[sessionCookie]
        if (token) {
          const hash = yield* credentialCrypto.sha256Hex(token).pipe(Effect.mapError(toApiFailure))
          yield* database.run("DELETE FROM admin_sessions WHERE token_hash = ?", [hash]).pipe(
            Effect.mapError(toApiFailure)
          )
        }
        return cookie(request, "", 0, new Date(0))
      })

      return Auth.of({
        me: (request) => Effect.map(isAdmin(request), (authenticated) => ({ auth_required: true, authenticated } as const)),
        requireAdmin,
        requireSameOrigin,
        login,
        logout
      })
    })
  )
}

export class System extends Context.Service<System, {
  readonly health: Effect.Effect<{ readonly status: string }, ApiFailure>
  readonly publicKey: Effect.Effect<{ readonly public_key: string }, ApiFailure>
  readonly status: (origin: string) => Effect.Effect<typeof StatusSchema.Type, ApiFailure>
  readonly testNotification: (projectId?: string) => Effect.Effect<{
    readonly event: EventView
    readonly web_push_configured: boolean
  }, ApiFailure>
}>()("ops-context/System") {
  static readonly layer = Layer.effect(
    System,
    Effect.gen(function*() {
      const database = yield* Database
      const config = yield* AppConfig
      const settings = yield* Settings
      const projects = yield* Projects
      const events = yield* Events

      const health = database.first<{ readonly ok: number }>("SELECT 1 AS ok").pipe(
        Effect.map(() => ({ status: "ok" })),
        Effect.mapError(toApiFailure),
        Effect.withSpan("System.health")
      )

      const publicKey = config.vapidPublicKey
        ? Effect.succeed({ public_key: config.vapidPublicKey })
        : Effect.fail(new ServiceUnavailableError({
          error: "push_not_configured",
          message: "Web Push is not configured"
        }))

      const status = Effect.fn("System.status")(function*(origin: string) {
        const counts = yield* database.first<{
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
        ).pipe(Effect.mapError(toApiFailure))
        const lastPush = yield* database.first<DeliveryRow>(
          `SELECT d.id, d.event_id, d.subscription_id,
                  COALESCE(s.name, '') AS subscription_name,
                  d.status, d.response_status, d.error, d.attempted_at
           FROM deliveries d
           LEFT JOIN push_subscriptions s ON s.id = d.subscription_id
           ORDER BY d.attempted_at DESC LIMIT 1`
        ).pipe(Effect.mapError(toApiFailure))
        const currentSettings = yield* settings.get

        return {
          version: "0.3.0",
          server: "ops-context/effect-v4/cloudflare-workers",
          database: "Cloudflare D1 / Effect SQL",
          base_url: config.baseUrl ?? origin,
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
          retention_days: currentSettings.retention_days,
          setup_completed: currentSettings.setup_completed,
          admin_auth: true
        }
      })

      const testNotification = Effect.fn("System.testNotification")(function*(projectId?: string) {
        const selected = projectId ? yield* projects.findRow(projectId) : yield* projects.firstRow
        if (!selected) {
          return yield* new NotFoundError({
            error: "not_found",
            message: "create a project before sending a test notification"
          })
        }
        const event = yield* events.create(selected, {
          title: "Ops Context is connected",
          body: "Web Push delivery is working.",
          level: "success",
          source: "ops-context",
          type: "test",
          fingerprint: "ops-context-test",
          data: { test: true }
        })
        return {
          event,
          web_push_configured: Boolean(config.vapidPublicKey && config.vapidPrivateJwk && config.vapidSubject)
        }
      })

      return System.of({ health, publicKey, status, testNotification })
    })
  )
}

export class PushDelivery extends Context.Service<PushDelivery, {
  readonly process: (message: PushJobMessage) => Effect.Effect<PushOutcome, AppError>
}>()("ops-context/PushDelivery") {
  static readonly layer = Layer.effect(
    PushDelivery,
    Effect.gen(function*() {
      const context = yield* Effect.context<Database | WebPush | CredentialCrypto>()
      return PushDelivery.of({
        process: (message) => provideAll(processPushMessage(message), context)
      })
    })
  )
}

export class Maintenance extends Context.Service<Maintenance, {
  readonly run: Effect.Effect<MaintenanceResult, AppError>
}>()("ops-context/Maintenance") {
  static readonly layer = Layer.effect(
    Maintenance,
    Effect.gen(function*() {
      const context = yield* Effect.context<Database | PushQueue | AppConfig>()
      return Maintenance.of({ run: provideAll(runMaintenance, context) })
    })
  )
}

export const unexpected = (message: string): InternalError =>
  new InternalError({ error: "internal", message })

export const conflictFailure = (message: string): ConflictError =>
  new ConflictError({ error: "conflict", message })
