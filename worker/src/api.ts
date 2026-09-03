import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi
} from "effect/unstable/httpapi"
import {
  BadRequestError,
  CommonErrors,
  CreateEventInput,
  CreateProjectInput,
  CreateSilenceInput,
  Deliveries,
  Event,
  EventAccepted,
  EventGroupsRebuilt,
  EventListQuery,
  EventPage,
  Health,
  Project,
  ProjectCreated,
  ProjectListQuery,
  Projects as ProjectsResponse,
  PushPublicKey,
  PushSubscription,
  PushSubscriptionCredential,
  PushSubscriptions,
  RegisterSubscriptionInput,
  RenewSubscriptionInput,
  Settings as SettingsResponse,
  Silence,
  Silences as SilencesResponse,
  Status,
  TestNotificationInput,
  TestNotificationResult,
  Unsilenced,
  UpdateProjectInput,
  UpdateSettingsInput,
  UpdateSubscriptionInput,
  type ApiFailure,
  toApiFailure
} from "./api-models.js"
import {
  pushPublicKey,
  rebuildEventGroups,
  systemHealth,
  systemStatus,
  testNotification
} from "./application.js"
import { decodeCreateEventInput } from "./event-contract.js"
import type { ApplicationError } from "./errors.js"
import {
  enqueueEventForProject,
  eventDeliveries,
  getEvent,
  listEvents,
  unsilenceEvent
} from "./events.js"
import {
  AdminAuthorization,
  CurrentProject,
  ProjectAuthorization,
  SameOrigin
} from "./middleware.js"
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  rotateProjectKey,
  updateProject
} from "./projects.js"
import {
  DeliveriesRepository,
  EventsRepository,
  ProjectsRepository,
  SettingsRepository,
  SilencesRepository,
  SubscriptionsRepository,
  SystemRepository
} from "./repositories.js"
import { AppConfig, CredentialCrypto, PushQueue } from "./services.js"
import {
  createSilence,
  deleteSilence,
  getSilence,
  listSilences
} from "./silences.js"
import { getSettings, updateSettings } from "./settings.js"
import {
  deleteSubscription,
  listSubscriptions,
  registerSubscription,
  renewSubscription,
  updateSubscription
} from "./subscriptions.js"

const SchemaString = Schema.String

export class HealthApiGroup extends HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: Health,
      error: CommonErrors
    })
  )
{}

export class PublicApiGroup extends HttpApiGroup.make("public")
  .add(
    HttpApiEndpoint.get("pushPublicKey", "/push/public-key", {
      success: PushPublicKey,
      error: CommonErrors
    })
  )
  .add(
    HttpApiEndpoint.post("renewSubscription", "/push/subscriptions/:id/renew", {
      params: { id: SchemaString },
      payload: RenewSubscriptionInput,
      success: PushSubscriptionCredential,
      error: CommonErrors
    })
  )
  .prefix("/api/v1")
{}

export class IngestApiGroup extends HttpApiGroup.make("ingest")
  .add(
    HttpApiEndpoint.post("createEvent", "/events", {
      payload: CreateEventInput,
      success: EventAccepted.pipe(HttpApiSchema.status(202)),
      error: CommonErrors
    })
  )
  .middleware(ProjectAuthorization)
  .prefix("/api/v1")
{}

export class AdminApiGroup extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("listEvents", "/events", {
      query: EventListQuery,
      success: EventPage,
      error: CommonErrors
    }),
    HttpApiEndpoint.get("getEvent", "/events/:id", {
      params: { id: SchemaString },
      success: Event,
      error: CommonErrors
    }),
    HttpApiEndpoint.get("eventDeliveries", "/events/:id/deliveries", {
      params: { id: SchemaString },
      success: Deliveries,
      error: CommonErrors
    }),
    HttpApiEndpoint.post("unsilenceEvent", "/events/:id/unsilence", {
      params: { id: SchemaString },
      success: Unsilenced,
      error: CommonErrors
    }).middleware(SameOrigin),

    HttpApiEndpoint.get("listProjects", "/projects", {
      query: ProjectListQuery,
      success: ProjectsResponse,
      error: CommonErrors
    }),
    HttpApiEndpoint.post("createProject", "/projects", {
      payload: CreateProjectInput,
      success: ProjectCreated.pipe(HttpApiSchema.status(201)),
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.get("getProject", "/projects/:id", {
      params: { id: SchemaString },
      success: Project,
      error: CommonErrors
    }),
    HttpApiEndpoint.patch("updateProject", "/projects/:id", {
      params: { id: SchemaString },
      payload: UpdateProjectInput,
      success: Project,
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.delete("deleteProject", "/projects/:id", {
      params: { id: SchemaString },
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.post("rotateProjectKey", "/projects/:id/rotate-key", {
      params: { id: SchemaString },
      success: ProjectCreated,
      error: CommonErrors
    }).middleware(SameOrigin),

    HttpApiEndpoint.get("listSubscriptions", "/push/subscriptions", {
      success: PushSubscriptions,
      error: CommonErrors
    }),
    HttpApiEndpoint.post("registerSubscription", "/push/subscriptions", {
      payload: RegisterSubscriptionInput,
      success: PushSubscriptionCredential.pipe(HttpApiSchema.status(201)),
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.patch("updateSubscription", "/push/subscriptions/:id", {
      params: { id: SchemaString },
      payload: UpdateSubscriptionInput,
      success: PushSubscription,
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.delete("deleteSubscription", "/push/subscriptions/:id", {
      params: { id: SchemaString },
      error: CommonErrors
    }).middleware(SameOrigin),

    HttpApiEndpoint.get("listSilences", "/silences", {
      success: SilencesResponse,
      error: CommonErrors
    }),
    HttpApiEndpoint.post("createSilence", "/silences", {
      payload: CreateSilenceInput,
      success: Silence.pipe(HttpApiSchema.status(201)),
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.get("getSilence", "/silences/:id", {
      params: { id: SchemaString },
      success: Silence,
      error: CommonErrors
    }),
    HttpApiEndpoint.delete("deleteSilence", "/silences/:id", {
      params: { id: SchemaString },
      error: CommonErrors
    }).middleware(SameOrigin),

    HttpApiEndpoint.get("getSettings", "/settings", {
      success: SettingsResponse,
      error: CommonErrors
    }),
    HttpApiEndpoint.patch("updateSettings", "/settings", {
      payload: UpdateSettingsInput,
      success: SettingsResponse,
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.get("status", "/status", {
      success: Status,
      error: CommonErrors
    }),
    HttpApiEndpoint.post("rebuildEventGroups", "/maintenance/event-groups/rebuild", {
      success: EventGroupsRebuilt,
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.post("testNotification", "/test", {
      payload: TestNotificationInput,
      success: TestNotificationResult.pipe(HttpApiSchema.status(202)),
      error: CommonErrors
    }).middleware(SameOrigin)
  )
  .middleware(AdminAuthorization)
  .prefix("/api/v1")
{}

export class OpsApi extends HttpApi.make("ops-context")
  .add(HealthApiGroup)
  .add(PublicApiGroup)
  .add(IngestApiGroup)
  .add(AdminApiGroup)
  .annotateMerge(OpenApi.annotations({
    title: "Ops Context API",
    version: "0.3.0",
    description: "Operational events, fingerprint groups, actions, browser push, silences, MCP, and Cloudflare Access administration."
  }))
{}

const requestOrigin = (request: HttpServerRequest.HttpServerRequest): string => {
  const protocol = request.headers["x-forwarded-proto"] ?? "https"
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost"
  return `${protocol}://${host}`
}

const toHttpFailure = <A, E extends ApplicationError, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, ApiFailure, R> => Effect.mapError(effect, toApiFailure)

export const HealthHandlers = HttpApiBuilder.group(
  OpsApi,
  "health",
  Effect.fn(function*(handlers) {
    const context = yield* Effect.context<SystemRepository>()
    return handlers.handle("health", () =>
      toHttpFailure(Effect.provide(systemHealth, context)))
  })
)

export const PublicHandlers = HttpApiBuilder.group(
  OpsApi,
  "public",
  Effect.fn(function*(handlers) {
    const context = yield* Effect.context<AppConfig | SubscriptionsRepository | CredentialCrypto>()
    return handlers.handleAll({
      pushPublicKey: () => toHttpFailure(Effect.provide(pushPublicKey, context)),
      renewSubscription: Effect.fn(function*({ params, payload }) {
        const request = yield* HttpServerRequest.HttpServerRequest
        const authorization = request.headers.authorization ?? ""
        const credential = authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length).trim()
          : ""
        return yield* toHttpFailure(Effect.provide(renewSubscription(
          params.id,
          credential,
          payload.subscription,
          request.headers["user-agent"] ?? ""
        ), context))
      })
    })
  })
)

export const IngestHandlers = HttpApiBuilder.group(
  OpsApi,
  "ingest",
  Effect.fn(function*(handlers) {
    const context = yield* Effect.context<
      EventsRepository | SettingsRepository | PushQueue | CredentialCrypto | AppConfig
    >()
    return handlers.handleRaw("createEvent", () =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const payload = yield* request.json.pipe(
          Effect.mapError(() => new BadRequestError({
            error: "bad_request",
            message: "request body must contain valid JSON"
          })),
          Effect.flatMap((input) =>
            decodeCreateEventInput(input).pipe(Effect.mapError(toApiFailure))
          )
        )
        const project = yield* CurrentProject
        const event = yield* toHttpFailure(Effect.provide(
          enqueueEventForProject(project, payload),
          context
        ))
        return event
      }))
  })
)

export const AdminHandlers = HttpApiBuilder.group(
  OpsApi,
  "admin",
  Effect.fn(function*(handlers) {
    const context = yield* Effect.context<
      AppConfig | CredentialCrypto | PushQueue |
      ProjectsRepository | EventsRepository | SubscriptionsRepository |
      SilencesRepository | SettingsRepository | DeliveriesRepository | SystemRepository
    >()
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provide(effect, context)
    return handlers.handleAll({
      listEvents: ({ query }) => toHttpFailure(provide(listEvents(query))),
      getEvent: ({ params }) => toHttpFailure(provide(getEvent(params.id))),
      eventDeliveries: ({ params }) =>
        Effect.map(toHttpFailure(provide(eventDeliveries(params.id))), (deliveries) => ({ deliveries })),
      unsilenceEvent: ({ params }) => toHttpFailure(provide(unsilenceEvent(params.id))),

      listProjects: ({ query }) => toHttpFailure(provide(listProjects(query))),
      createProject: ({ payload }) => toHttpFailure(provide(createProject(payload))),
      getProject: ({ params }) => toHttpFailure(provide(getProject(params.id))),
      updateProject: ({ params, payload }) => toHttpFailure(provide(updateProject(params.id, payload))),
      deleteProject: ({ params }) => toHttpFailure(provide(deleteProject(params.id))),
      rotateProjectKey: ({ params }) => toHttpFailure(provide(rotateProjectKey(params.id))),

      listSubscriptions: () => Effect.map(toHttpFailure(provide(listSubscriptions)), (subscriptions) => ({ subscriptions })),
      registerSubscription: Effect.fn(function*({ payload }) {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* toHttpFailure(provide(registerSubscription(payload, request.headers["user-agent"] ?? "")))
      }),
      updateSubscription: ({ params, payload }) => toHttpFailure(provide(updateSubscription(params.id, {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {})
      }))),
      deleteSubscription: ({ params }) => toHttpFailure(provide(deleteSubscription(params.id))),

      listSilences: () => toHttpFailure(provide(Effect.gen(function*() {
        const repository = yield* SilencesRepository
        return {
          silences: yield* listSilences,
          fields: ["fingerprint", "title", "source"] as const,
          silenced_events: yield* repository.countSilencedEvents
        }
      }))),
      createSilence: ({ payload }) => toHttpFailure(provide(createSilence(payload))),
      getSilence: ({ params }) => toHttpFailure(provide(getSilence(params.id))),
      deleteSilence: ({ params }) => toHttpFailure(provide(deleteSilence(params.id))),

      getSettings: () => toHttpFailure(provide(getSettings)),
      updateSettings: ({ payload }) => toHttpFailure(provide(updateSettings(payload))),
      status: Effect.fn(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* toHttpFailure(provide(systemStatus(requestOrigin(request))))
      }),
      rebuildEventGroups: () => toHttpFailure(provide(rebuildEventGroups)),
      testNotification: Effect.fn(function*({ payload }) {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* toHttpFailure(provide(
          testNotification(requestOrigin(request), payload.project_id)
        ))
      })
    })
  })
)

export const ApiHandlers = Layer.mergeAll(
  HealthHandlers,
  PublicHandlers,
  IngestHandlers,
  AdminHandlers
)
