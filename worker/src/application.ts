import { Context, Effect, Layer } from "effect"
import { Status as StatusSchema } from "./api-models.js"
import {
  createEventForProject,
  eventDeliveries,
  getEvent,
  listEvents,
  unsilenceEvent,
  type CreateEventInput,
  type EventPage,
  type EventError,
  type ListEventsInput
} from "./events.js"
import {
  projectNotFound,
  pushNotConfigured,
  type CryptographyUnavailable,
  type EventNotFound,
  type InvalidEventQuery,
  type InvalidProject,
  type InvalidProjectCredential,
  type InvalidSettings,
  type InvalidSilence,
  type InvalidSubscription,
  type ProjectDeletionConflict,
  type ProjectNotFound,
  type PushNotConfigured,
  type QueueUnavailable,
  type RepositoryUnavailable,
  type SilenceNotFound,
  type SubscriptionNotFound
} from "./errors.js"
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
  type ProjectError,
  type UpdateProjectInput
} from "./projects.js"
import { processDeadLetterMessage, processPushMessage, type PushDeliveryError, type PushOutcome } from "./push.js"
import { PushDeliveryRepository } from "./push-repository.js"
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

type SubscriptionError = InvalidSubscription | SubscriptionNotFound |
  RepositoryUnavailable | CryptographyUnavailable
type SilenceError = InvalidSilence | ProjectNotFound | SilenceNotFound |
  RepositoryUnavailable | CryptographyUnavailable
type SettingsError = InvalidSettings | RepositoryUnavailable
type SystemError = RepositoryUnavailable | PushNotConfigured | ProjectNotFound | EventError

export class Projects extends Context.Service<Projects, {
  readonly list: Effect.Effect<ReadonlyArray<ProjectView>, RepositoryUnavailable>
  readonly get: (id: string) => Effect.Effect<ProjectView, ProjectNotFound | RepositoryUnavailable>
  readonly findRow: (id: string) => Effect.Effect<ProjectRow, ProjectNotFound | RepositoryUnavailable>
  readonly firstRow: Effect.Effect<ProjectRow | null, RepositoryUnavailable>
  readonly authenticate: (apiKey: string) => Effect.Effect<ProjectRow, InvalidProjectCredential | RepositoryUnavailable | CryptographyUnavailable>
  readonly create: (
    input: CreateProjectInput
  ) => Effect.Effect<ProjectView & { readonly api_key: string }, ProjectError>
  readonly update: (
    id: string,
    patch: UpdateProjectInput
  ) => Effect.Effect<ProjectView, InvalidProject | ProjectNotFound | RepositoryUnavailable>
  readonly delete: (id: string) => Effect.Effect<void, ProjectNotFound | ProjectDeletionConflict | RepositoryUnavailable>
  readonly rotateKey: (
    id: string
  ) => Effect.Effect<ProjectView & { readonly api_key: string }, ProjectNotFound | RepositoryUnavailable | CryptographyUnavailable>
}>()("ops-context/Projects") {
  static readonly layer = Layer.effect(
    Projects,
    Effect.gen(function*() {
      const database = yield* Database
      const crypto = yield* CredentialCrypto
      const run = <A, E>(effect: Effect.Effect<A, E, Database | CredentialCrypto>) =>
        effect.pipe(
          Effect.provideService(Database, database),
          Effect.provideService(CredentialCrypto, crypto)
        )
      const runDb = <A, E>(effect: Effect.Effect<A, E, Database>) =>
        Effect.provideService(effect, Database, database)

      return Projects.of({
        list: runDb(listProjects).pipe(Effect.withSpan("Projects.list")),
        get: Effect.fn("Projects.get")((id: string) => runDb(getProject(id))),
        findRow: Effect.fn("Projects.findRow")((id: string) => runDb(findProjectRow(id))),
        firstRow: database.first<ProjectRow>("SELECT * FROM projects ORDER BY created_at LIMIT 1"),
        authenticate: Effect.fn("Projects.authenticate")((apiKey: string) =>
          run(authenticateProject(apiKey))
        ),
        create: Effect.fn("Projects.create")((input: CreateProjectInput) =>
          run(createProject(input))
        ),
        update: Effect.fn("Projects.update")((id: string, patch: UpdateProjectInput) =>
          runDb(updateProject(id, patch))
        ),
        delete: Effect.fn("Projects.delete")((id: string) => runDb(deleteProject(id))),
        rotateKey: Effect.fn("Projects.rotateKey")((id: string) => run(rotateProjectKey(id)))
      })
    })
  )
}

export class Events extends Context.Service<Events, {
  readonly create: (
    project: ProjectRow,
    input: CreateEventInput
  ) => Effect.Effect<EventView, EventError>
  readonly list: (input: ListEventsInput) => Effect.Effect<EventPage, InvalidEventQuery | RepositoryUnavailable>
  readonly get: (id: string) => Effect.Effect<EventView, EventNotFound | RepositoryUnavailable>
  readonly deliveries: (id: string) => Effect.Effect<ReadonlyArray<DeliveryRow>, EventNotFound | RepositoryUnavailable>
  readonly unsilence: (id: string) => Effect.Effect<{
    readonly event: EventView
    readonly deliveries: ReadonlyArray<DeliveryRow>
  }, EventNotFound | RepositoryUnavailable | QueueUnavailable>
}>()("ops-context/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function*() {
      const database = yield* Database
      const queue = yield* PushQueue
      const config = yield* AppConfig
      const crypto = yield* CredentialCrypto
      const run = <A, E>(effect: Effect.Effect<
        A,
        E,
        Database | PushQueue | AppConfig | CredentialCrypto
      >) => effect.pipe(
        Effect.provideService(Database, database),
        Effect.provideService(PushQueue, queue),
        Effect.provideService(AppConfig, config),
        Effect.provideService(CredentialCrypto, crypto)
      )

      return Events.of({
        create: Effect.fn("Events.create")((project: ProjectRow, input: CreateEventInput) =>
          run(createEventForProject(project, input))
        ),
        list: Effect.fn("Events.list")((input: ListEventsInput) =>
          Effect.provideService(listEvents(input), Database, database)
        ),
        get: Effect.fn("Events.get")((id: string) =>
          Effect.provideService(getEvent(id), Database, database)
        ),
        deliveries: Effect.fn("Events.deliveries")((id: string) =>
          Effect.provideService(eventDeliveries(id), Database, database)
        ),
        unsilence: Effect.fn("Events.unsilence")((id: string) =>
          unsilenceEvent(id).pipe(
            Effect.provideService(Database, database),
            Effect.provideService(PushQueue, queue)
          )
        )
      })
    })
  )
}

export class Subscriptions extends Context.Service<Subscriptions, {
  readonly list: Effect.Effect<ReadonlyArray<PushSubscriptionView>, RepositoryUnavailable>
  readonly register: (
    input: RegisterSubscriptionInput,
    userAgent: string
  ) => Effect.Effect<PushSubscriptionView, SubscriptionError>
  readonly update: (
    id: string,
    patch: { readonly name?: string | undefined; readonly enabled?: boolean | undefined }
  ) => Effect.Effect<PushSubscriptionView, InvalidSubscription | SubscriptionNotFound | RepositoryUnavailable>
  readonly delete: (id: string) => Effect.Effect<void, SubscriptionNotFound | RepositoryUnavailable>
}>()("ops-context/Subscriptions") {
  static readonly layer = Layer.effect(
    Subscriptions,
    Effect.gen(function*() {
      const database = yield* Database
      const crypto = yield* CredentialCrypto
      return Subscriptions.of({
        list: Effect.provideService(listSubscriptions, Database, database),
        register: Effect.fn("Subscriptions.register")((input, userAgent) =>
          registerSubscription(input, userAgent).pipe(
            Effect.provideService(Database, database),
            Effect.provideService(CredentialCrypto, crypto)
          )
        ),
        update: Effect.fn("Subscriptions.update")((id, patch) =>
          Effect.provideService(updateSubscription(id, patch), Database, database)
        ),
        delete: Effect.fn("Subscriptions.delete")((id: string) =>
          Effect.provideService(deleteSubscription(id), Database, database)
        )
      })
    })
  )
}

export class Silences extends Context.Service<Silences, {
  readonly list: Effect.Effect<ReadonlyArray<SilenceRow>, RepositoryUnavailable>
  readonly listSummary: Effect.Effect<{
    readonly silences: ReadonlyArray<SilenceRow>
    readonly fields: ReadonlyArray<"fingerprint" | "title" | "source">
    readonly silenced_events: number
  }, RepositoryUnavailable>
  readonly get: (id: string) => Effect.Effect<SilenceRow, SilenceNotFound | RepositoryUnavailable>
  readonly create: (input: CreateSilenceInput) => Effect.Effect<SilenceRow, SilenceError>
  readonly delete: (id: string) => Effect.Effect<void, SilenceNotFound | RepositoryUnavailable>
}>()("ops-context/Silences") {
  static readonly layer = Layer.effect(
    Silences,
    Effect.gen(function*() {
      const database = yield* Database
      const crypto = yield* CredentialCrypto
      const list = Effect.provideService(listSilences, Database, database)
      return Silences.of({
        list,
        listSummary: Effect.gen(function*() {
          const silences = yield* list
          const count = yield* database.first<{ readonly count: number }>(
            "SELECT COUNT(*) AS count FROM events WHERE silence_id IS NOT NULL"
          )
          return {
            silences,
            fields: ["fingerprint", "title", "source"] as const,
            silenced_events: count?.count ?? 0
          }
        }).pipe(Effect.withSpan("Silences.listSummary")),
        get: Effect.fn("Silences.get")((id: string) =>
          Effect.provideService(getSilence(id), Database, database)
        ),
        create: Effect.fn("Silences.create")((input: CreateSilenceInput) =>
          createSilence(input).pipe(
            Effect.provideService(Database, database),
            Effect.provideService(CredentialCrypto, crypto)
          )
        ),
        delete: Effect.fn("Silences.delete")((id: string) =>
          Effect.provideService(deleteSilence(id), Database, database)
        )
      })
    })
  )
}

export class Settings extends Context.Service<Settings, {
  readonly get: Effect.Effect<SettingsView, RepositoryUnavailable>
  readonly update: (patch: SettingsPatch) => Effect.Effect<SettingsView, SettingsError>
}>()("ops-context/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const database = yield* Database
      const config = yield* AppConfig
      return Settings.of({
        get: getSettings.pipe(
          Effect.provideService(Database, database),
          Effect.provideService(AppConfig, config),
          Effect.withSpan("Settings.get")
        ),
        update: Effect.fn("Settings.update")((patch: SettingsPatch) =>
          updateSettings(patch).pipe(
            Effect.provideService(Database, database),
            Effect.provideService(AppConfig, config)
          )
        )
      })
    })
  )
}

export class System extends Context.Service<System, {
  readonly health: Effect.Effect<{ readonly status: string }, RepositoryUnavailable>
  readonly publicKey: Effect.Effect<{ readonly public_key: string }, PushNotConfigured>
  readonly status: (origin: string) => Effect.Effect<typeof StatusSchema.Type, RepositoryUnavailable>
  readonly testNotification: (projectId?: string) => Effect.Effect<{
    readonly event: EventView
    readonly web_push_configured: boolean
  }, SystemError>
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
        Effect.withSpan("System.health")
      )

      const publicKey = config.vapidPublicKey
        ? Effect.succeed({ public_key: config.vapidPublicKey })
        : Effect.fail(pushNotConfigured())

      const status = Effect.fn("System.status")(function*(origin: string) {
        const counts = yield* database.first<{
          readonly projects: number
          readonly events: number
          readonly subscriptions: number
          readonly enabled_subscriptions: number
          readonly dead_jobs: number
        }>(
          `SELECT
             (SELECT COUNT(*) FROM projects) AS projects,
             (SELECT COUNT(*) FROM events) AS events,
             (SELECT COUNT(*) FROM push_subscriptions) AS subscriptions,
             (SELECT COUNT(*) FROM push_subscriptions WHERE enabled = 1) AS enabled_subscriptions,
             (SELECT COUNT(*) FROM push_jobs WHERE state = 'dead') AS dead_jobs`
        )

        const lastPush = yield* database.first<DeliveryRow>(
          `SELECT d.id, d.event_id, d.subscription_id,
                  COALESCE(s.name, '') AS subscription_name,
                  d.status, d.response_status, d.error, d.attempted_at
           FROM deliveries d
           LEFT JOIN push_subscriptions s ON s.id = d.subscription_id
           ORDER BY d.attempted_at DESC LIMIT 1`
        )
        const currentSettings = yield* settings.get

        return {
          version: "0.3.0",
          server: "ops-context/effect-v4/cloudflare-workers",
          database: "Cloudflare D1 / Effect SQL",
          base_url: config.baseUrl ?? origin,
          uptime_seconds: null,
          web_push: {
            configured: Boolean(
              config.vapidPublicKey && config.vapidPrivateJwk && config.vapidSubject
            ),
            subject: config.vapidSubject
          },
          projects: counts?.projects ?? 0,
          events: counts?.events ?? 0,
          subscriptions: counts?.subscriptions ?? 0,
          enabled_subscriptions: counts?.enabled_subscriptions ?? 0,
          dead_jobs: counts?.dead_jobs ?? 0,
          last_push: lastPush,
          retention_days: currentSettings.retention_days,
          setup_completed: currentSettings.setup_completed,
          admin_auth: Boolean(config.appHost && config.accessAppAudience),
          admin_auth_provider: "cloudflare-access" as const
        }
      })

      const testNotification = Effect.fn("System.testNotification")(function*(
        projectId?: string
      ) {
        const selected = projectId ? yield* projects.findRow(projectId) : yield* projects.firstRow
        if (!selected) {
          return yield* Effect.fail(projectNotFound("create a project before sending a test notification"))
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
          web_push_configured: Boolean(
            config.vapidPublicKey && config.vapidPrivateJwk && config.vapidSubject
          )
        }
      })

      return System.of({ health, publicKey, status, testNotification })
    })
  )
}

export class PushDelivery extends Context.Service<PushDelivery, {
  readonly process: (message: PushJobMessage) => Effect.Effect<PushOutcome, PushDeliveryError>
  readonly deadLetter: (message: PushJobMessage) => Effect.Effect<PushOutcome, PushDeliveryError>
}>()("ops-context/PushDelivery") {
  static readonly layer = Layer.effect(
    PushDelivery,
    Effect.gen(function*() {
      const repository = yield* PushDeliveryRepository
      const webPush = yield* WebPush
      const config = yield* AppConfig
      return PushDelivery.of({
        process: (message) => processPushMessage(message).pipe(
          Effect.provideService(PushDeliveryRepository, repository),
          Effect.provideService(WebPush, webPush),
          Effect.provideService(AppConfig, config)
        ),
        deadLetter: (message) => processDeadLetterMessage(message).pipe(
          Effect.provideService(PushDeliveryRepository, repository)
        )
      })
    })
  )
}

export class Maintenance extends Context.Service<Maintenance, {
  readonly run: Effect.Effect<MaintenanceResult, RepositoryUnavailable | QueueUnavailable>
}>()("ops-context/Maintenance") {
  static readonly layer = Layer.effect(
    Maintenance,
    Effect.gen(function*() {
      const database = yield* Database
      const queue = yield* PushQueue
      const config = yield* AppConfig
      return Maintenance.of({
        run: runMaintenance.pipe(
          Effect.provideService(Database, database),
          Effect.provideService(PushQueue, queue),
          Effect.provideService(AppConfig, config)
        )
      })
    })
  )
}
