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
  AccessIdentity,
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
  ProjectIcons,
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
  Events,
  Projects,
  Settings,
  Silences,
  Subscriptions,
  System
} from "./application.js"
import { decodeCreateEventInput } from "./event-contract.js"
import type { ApplicationError } from "./errors.js"
import {
  AdminAuthorization,
  CurrentAdmin,
  CurrentProject,
  ProjectAuthorization,
  SameOrigin
} from "./middleware.js"

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
    HttpApiEndpoint.get("accessIdentity", "/access/me", {
      success: AccessIdentity,
      error: CommonErrors
    }),
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
      success: ProjectsResponse,
      error: CommonErrors
    }),
    HttpApiEndpoint.get("projectIcons", "/projects/icons", {
      success: ProjectIcons,
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
    const system = yield* System
    return handlers.handle("health", () => toHttpFailure(system.health))
  })
)

export const PublicHandlers = HttpApiBuilder.group(
  OpsApi,
  "public",
  Effect.fn(function*(handlers) {
    const system = yield* System
    const subscriptions = yield* Subscriptions
    return handlers.handleAll({
      pushPublicKey: () => toHttpFailure(system.publicKey),
      renewSubscription: Effect.fn(function*({ params, payload }) {
        const request = yield* HttpServerRequest.HttpServerRequest
        const authorization = request.headers.authorization ?? ""
        const credential = authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length).trim()
          : ""
        return yield* toHttpFailure(subscriptions.renew(
          params.id,
          credential,
          payload.subscription,
          request.headers["user-agent"] ?? ""
        ))
      })
    })
  })
)

export const IngestHandlers = HttpApiBuilder.group(
  OpsApi,
  "ingest",
  Effect.fn(function*(handlers) {
    const events = yield* Events
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
        const event = yield* toHttpFailure(events.create(project, payload))
        return event
      }))
  })
)

export const AdminHandlers = HttpApiBuilder.group(
  OpsApi,
  "admin",
  Effect.fn(function*(handlers) {
    const events = yield* Events
    const projects = yield* Projects
    const subscriptions = yield* Subscriptions
    const silences = yield* Silences
    const settings = yield* Settings
    const system = yield* System

    return handlers.handleAll({
      accessIdentity: Effect.fn(function*() {
        const principal = yield* CurrentAdmin
        return {
          subject: principal.subject,
          kind: principal.kind,
          audience: principal.audience,
          ...(principal.email ? { email: principal.email } : {}),
          ...(principal.name ? { name: principal.name } : {})
        }
      }),
      listEvents: ({ query }) => toHttpFailure(events.list(query)),
      getEvent: ({ params }) => toHttpFailure(events.get(params.id)),
      eventDeliveries: ({ params }) =>
        Effect.map(toHttpFailure(events.deliveries(params.id)), (deliveries) => ({ deliveries })),
      unsilenceEvent: ({ params }) => toHttpFailure(events.unsilence(params.id)),

      listProjects: () => Effect.map(toHttpFailure(projects.list), (projects) => ({ projects })),
      projectIcons: () => Effect.succeed({
        icons: ["", "🚀", "🗄️", "💳", "🛡️", "📦", "⚙️", "🧪", "📈", "🔔"]
      }),
      createProject: ({ payload }) => toHttpFailure(projects.create(payload)),
      getProject: ({ params }) => toHttpFailure(projects.get(params.id)),
      updateProject: ({ params, payload }) => toHttpFailure(projects.update(params.id, payload)),
      deleteProject: ({ params }) => toHttpFailure(projects.delete(params.id)),
      rotateProjectKey: ({ params }) => toHttpFailure(projects.rotateKey(params.id)),

      listSubscriptions: () => Effect.map(toHttpFailure(subscriptions.list), (subscriptions) => ({ subscriptions })),
      registerSubscription: Effect.fn(function*({ payload }) {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* toHttpFailure(subscriptions.register(payload, request.headers["user-agent"] ?? ""))
      }),
      updateSubscription: ({ params, payload }) => toHttpFailure(subscriptions.update(params.id, {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {})
      })),
      deleteSubscription: ({ params }) => toHttpFailure(subscriptions.delete(params.id)),

      listSilences: () => toHttpFailure(silences.listSummary),
      createSilence: ({ payload }) => toHttpFailure(silences.create(payload)),
      getSilence: ({ params }) => toHttpFailure(silences.get(params.id)),
      deleteSilence: ({ params }) => toHttpFailure(silences.delete(params.id)),

      getSettings: () => toHttpFailure(settings.get),
      updateSettings: ({ payload }) => toHttpFailure(settings.update(payload)),
      status: Effect.fn(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* toHttpFailure(system.status(requestOrigin(request)))
      }),
      rebuildEventGroups: () => toHttpFailure(system.rebuildEventGroups),
      testNotification: ({ payload }) => toHttpFailure(system.testNotification(payload.project_id))
    })
  })
)

export const ApiHandlers = Layer.mergeAll(
  HealthHandlers,
  PublicHandlers,
  IngestHandlers,
  AdminHandlers
)
