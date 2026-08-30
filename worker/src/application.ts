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
  renewSubscription,
  updateSubscription,
  type BrowserPushSubscription,
  type RegisterSubscriptionInput,
  type SubscriptionCredentialResult,
  type SubscriptionOperationError
} from "./subscriptions.js"
import { runMaintenance, type MaintenanceResult } from "./maintenance.js"
import {
  DeliveriesRepository,
  EventsRepository,
  ProjectsRepository,
  PushJobsRepository,
  SettingsRepository,
  SilencesRepository,
  SubscriptionsRepository,
  SystemRepository
} from "./repositories.js"
import {
  AppConfig,
  CredentialCrypto,
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

type SubscriptionError = SubscriptionOperationError
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
      const repository = yield* ProjectsRepository
      const crypto = yield* CredentialCrypto
      const run = <A, E>(effect: Effect.Effect<A, E, ProjectsRepository | CredentialCrypto>) =>
        effect.pipe(
          Effect.provideService(ProjectsRepository, repository),
          Effect.provideService(CredentialCrypto, crypto)
        )
      const runRepository = <A, E>(effect: Effect.Effect<A, E, ProjectsRepository>) =>
        Effect.provideService(effect, ProjectsRepository, repository)

      return Projects.of({
        list: runRepository(listProjects).pipe(Effect.withSpan("Projects.list")),
        get: Effect.fn("Projects.get")((id: string) => runRepository(getProject(id))),
        findRow: Effect.fn("Projects.findRow")((id: string) => runRepository(findProjectRow(id))),
        firstRow: repository.findFirst,
        authenticate: Effect.fn("Projects.authenticate")((apiKey: string) =>
          run(authenticateProject(apiKey))
        ),
        create: Effect.fn("Projects.create")((input: CreateProjectInput) =>
          run(createProject(input))
        ),
        update: Effect.fn("Projects.update")((id: string, patch: UpdateProjectInput) =>
          runRepository(updateProject(id, patch))
        ),
        delete: Effect.fn("Projects.delete")((id: string) => runRepository(deleteProject(id))),
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
  readonly rebuildGroups: Effect.Effect<number, RepositoryUnavailable>
}>()("ops-context/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function*() {
      const eventsRepository = yield* EventsRepository
      const deliveriesRepository = yield* DeliveriesRepository
      const settingsRepository = yield* SettingsRepository
      const silencesRepository = yield* SilencesRepository
      const subscriptionsRepository = yield* SubscriptionsRepository
      const queue = yield* PushQueue
      const config = yield* AppConfig
      const crypto = yield* CredentialCrypto
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
        Effect.provideService(EventsRepository, eventsRepository),
        Effect.provideService(DeliveriesRepository, deliveriesRepository),
        Effect.provideService(SettingsRepository, settingsRepository),
        Effect.provideService(SilencesRepository, silencesRepository),
        Effect.provideService(SubscriptionsRepository, subscriptionsRepository),
        Effect.provideService(PushQueue, queue),
        Effect.provideService(AppConfig, config),
        Effect.provideService(CredentialCrypto, crypto)
      )

      return Events.of({
        create: Effect.fn("Events.create")((project: ProjectRow, input: CreateEventInput) =>
          provide(createEventForProject(project, input))
        ),
        list: Effect.fn("Events.list")((input: ListEventsInput) =>
          provide(listEvents(input))
        ),
        get: Effect.fn("Events.get")((id: string) =>
          provide(getEvent(id))
        ),
        deliveries: Effect.fn("Events.deliveries")((id: string) =>
          provide(eventDeliveries(id))
        ),
        unsilence: Effect.fn("Events.unsilence")((id: string) =>
          provide(unsilenceEvent(id))
        ),
        rebuildGroups: eventsRepository.rebuildGroups
      })
    })
  )
}

export class Subscriptions extends Context.Service<Subscriptions, {
  readonly list: Effect.Effect<ReadonlyArray<PushSubscriptionView>, RepositoryUnavailable>
  readonly register: (
    input: RegisterSubscriptionInput,
    userAgent: string
  ) => Effect.Effect<SubscriptionCredentialResult, SubscriptionError>
  readonly renew: (
    id: string,
    credential: string,
    subscription: BrowserPushSubscription,
    userAgent: string
  ) => Effect.Effect<SubscriptionCredentialResult, SubscriptionError>
  readonly update: (
    id: string,
    patch: { readonly name?: string | undefined; readonly enabled?: boolean | undefined }
  ) => Effect.Effect<PushSubscriptionView, InvalidSubscription | SubscriptionNotFound | RepositoryUnavailable>
  readonly delete: (id: string) => Effect.Effect<void, SubscriptionNotFound | RepositoryUnavailable>
}>()("ops-context/Subscriptions") {
  static readonly layer = Layer.effect(
    Subscriptions,
    Effect.gen(function*() {
      const repository = yield* SubscriptionsRepository
      const crypto = yield* CredentialCrypto
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
        Effect.provideService(SubscriptionsRepository, repository),
        Effect.provideService(CredentialCrypto, crypto)
      )
      return Subscriptions.of({
        list: provide(listSubscriptions),
        register: Effect.fn("Subscriptions.register")((input, userAgent) =>
          provide(registerSubscription(input, userAgent))
        ),
        renew: Effect.fn("Subscriptions.renew")((id, credential, subscription, userAgent) =>
          provide(renewSubscription(id, credential, subscription, userAgent))
        ),
        update: Effect.fn("Subscriptions.update")((id, patch) =>
          provide(updateSubscription(id, patch))
        ),
        delete: Effect.fn("Subscriptions.delete")((id: string) =>
          provide(deleteSubscription(id))
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
      const repository = yield* SilencesRepository
      const projectsRepository = yield* ProjectsRepository
      const crypto = yield* CredentialCrypto
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
        Effect.provideService(SilencesRepository, repository),
        Effect.provideService(ProjectsRepository, projectsRepository),
        Effect.provideService(CredentialCrypto, crypto)
      )
      const list = provide(listSilences)
      return Silences.of({
        list,
        listSummary: Effect.gen(function*() {
          const silences = yield* list
          const count = yield* repository.countSilencedEvents
          return {
            silences,
            fields: ["fingerprint", "title", "source"] as const,
            silenced_events: count
          }
        }).pipe(Effect.withSpan("Silences.listSummary")),
        get: Effect.fn("Silences.get")((id: string) =>
          provide(getSilence(id))
        ),
        create: Effect.fn("Silences.create")((input: CreateSilenceInput) =>
          provide(createSilence(input))
        ),
        delete: Effect.fn("Silences.delete")((id: string) =>
          provide(deleteSilence(id))
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
      const repository = yield* SettingsRepository
      const config = yield* AppConfig
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
        Effect.provideService(SettingsRepository, repository),
        Effect.provideService(AppConfig, config)
      )
      return Settings.of({
        get: provide(getSettings).pipe(
          Effect.withSpan("Settings.get")
        ),
        update: Effect.fn("Settings.update")((patch: SettingsPatch) =>
          provide(updateSettings(patch))
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
  readonly rebuildEventGroups: Effect.Effect<{ readonly groups: number }, RepositoryUnavailable>
}>()("ops-context/System") {
  static readonly layer = Layer.effect(
    System,
    Effect.gen(function*() {
      const systemRepository = yield* SystemRepository
      const deliveriesRepository = yield* DeliveriesRepository
      const config = yield* AppConfig
      const settings = yield* Settings
      const projects = yield* Projects
      const events = yield* Events

      const health = systemRepository.health.pipe(
        Effect.map(() => ({ status: "ok" })),
        Effect.withSpan("System.health")
      )

      const publicKey = config.vapidPublicKey
        ? Effect.succeed({ public_key: config.vapidPublicKey })
        : Effect.fail(pushNotConfigured())

      const status = Effect.fn("System.status")(function*(origin: string) {
        const counts = yield* systemRepository.counts
        const lastPush = yield* deliveriesRepository.latest
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
          projects: counts.projects,
          events: counts.events,
          subscriptions: counts.subscriptions,
          enabled_subscriptions: counts.enabled_subscriptions,
          dead_jobs: counts.dead_jobs,
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

      const rebuildGroups = events.rebuildGroups.pipe(
        Effect.map((groups) => ({ groups })),
        Effect.withSpan("System.rebuildEventGroups")
      )

      return System.of({
        health,
        publicKey,
        status,
        testNotification,
        rebuildEventGroups: rebuildGroups
      })
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
      const eventsRepository = yield* EventsRepository
      const pushJobsRepository = yield* PushJobsRepository
      const settingsRepository = yield* SettingsRepository
      const queue = yield* PushQueue
      const config = yield* AppConfig
      return Maintenance.of({
        run: runMaintenance.pipe(
          Effect.provideService(EventsRepository, eventsRepository),
          Effect.provideService(PushJobsRepository, pushJobsRepository),
          Effect.provideService(SettingsRepository, settingsRepository),
          Effect.provideService(PushQueue, queue),
          Effect.provideService(AppConfig, config)
        )
      })
    })
  )
}
