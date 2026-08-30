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
  AuthLoginInput,
  AuthState,
  AuthStateWithCookie,
  CommonErrors,
  CreateEventInput,
  CreateProjectInput,
  CreateSilenceInput,
  Deliveries,
  Event,
  EventCreated,
  EventListQuery,
  EventPage,
  Health,
  LogoutWithCookie,
  Project,
  ProjectCreated,
  ProjectIcons,
  Projects as ProjectsResponse,
  PushPublicKey,
  PushSubscription,
  PushSubscriptions,
  RegisterSubscriptionInput,
  Settings as SettingsResponse,
  Silence,
  Silences as SilencesResponse,
  Status,
  TestNotificationInput,
  TestNotificationResult,
  Unsilenced,
  UpdateProjectInput,
  UpdateSettingsInput,
  UpdateSubscriptionInput
} from "./api-models.js"
import {
  Auth,
  Events,
  Projects,
  Settings,
  Silences,
  Subscriptions,
  System
} from "./application.js"
import {
  AdminAuthorization,
  CurrentProject,
  ProjectAuthorization,
  SameOrigin
} from "./middleware.js"

// Kept as a named schema so path codecs remain explicit and reusable.
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
    HttpApiEndpoint.get("authMe", "/auth/me", {
      success: AuthState,
      error: CommonErrors
    }),
    HttpApiEndpoint.post("authLogin", "/auth/login", {
      payload: AuthLoginInput,
      success: AuthStateWithCookie,
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.post("authLogout", "/auth/logout", {
      success: LogoutWithCookie,
      error: CommonErrors
    }).middleware(SameOrigin),
    HttpApiEndpoint.get("pushPublicKey", "/push/public-key", {
      success: PushPublicKey,
      error: CommonErrors
    })
  )
  .prefix("/api/v1")
{}

export class IngestApiGroup extends HttpApiGroup.make("ingest")
  .add(
    HttpApiEndpoint.post("createEvent", "/events", {
      payload: CreateEventInput,
      success: EventCreated.pipe(HttpApiSchema.status(201)),
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
      success: PushSubscription.pipe(HttpApiSchema.status(201)),
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
    HttpApiEndpoint.post("testNotification", "/test", {
      payload: TestNotificationInput,
      success: TestNotificationResult.pipe(HttpApiSchema.status(201)),
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
    description: "Operational events, fingerprint groups, actions, browser push, silences, MCP, and administration."
  }))
{}

const requestOrigin = (request: HttpServerRequest.HttpServerRequest): string => {
  const protocol = request.headers["x-forwarded-proto"] ?? "https"
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost"
  return `${protocol}://${host}`
}

export const HealthHandlers = HttpApiBuilder.group(
  OpsApi,
  "health",
  Effect.fn(function*(handlers) {
    const system = yield* System
    return handlers.handle("health", () => system.health)
  })
)

export const PublicHandlers = HttpApiBuilder.group(
  OpsApi,
  "public",
  Effect.fn(function*(handlers) {
    const auth = yield* Auth
    const system = yield* System

    return handlers.handleAll({
      authMe: Effect.fn(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* auth.me(request)
      }),
      authLogin: Effect.fn(function*({ payload }) {
        const request = yield* HttpServerRequest.HttpServerRequest
        const result = yield* auth.login(request, payload)
        return HttpApiSchema.withHeaders({
          body: result.state,
          headers: { "set-cookie": result.cookie }
        })
      }),
      authLogout: Effect.fn(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const cookie = yield* auth.logout(request)
        return HttpApiSchema.withHeaders({
          body: undefined,
          headers: { "set-cookie": cookie }
        })
      }),
      pushPublicKey: () => system.publicKey
    })
  })
)

export const IngestHandlers = HttpApiBuilder.group(
  OpsApi,
  "ingest",
  Effect.fn(function*(handlers) {
    const events = yield* Events
    return handlers.handle("createEvent", ({ payload }) =>
      Effect.gen(function*() {
        const project = yield* CurrentProject
        const event = yield* events.create(project, payload)
        return { id: event.id, created_at: event.created_at }
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
      listEvents: ({ query }) => events.list(query),
      getEvent: ({ params }) => events.get(params.id),
      eventDeliveries: ({ params }) =>
        Effect.map(events.deliveries(params.id), (deliveries) => ({ deliveries })),
      unsilenceEvent: ({ params }) => events.unsilence(params.id),

      listProjects: () => Effect.map(projects.list, (projects) => ({ projects })),
      projectIcons: () => Effect.succeed({
        icons: ["", "🚀", "🗄️", "💳", "🛡️", "📦", "⚙️", "🧪", "📈", "🔔"]
      }),
      createProject: ({ payload }) => projects.create(payload),
      getProject: ({ params }) => projects.get(params.id),
      updateProject: ({ params, payload }) => projects.update(params.id, payload),
      deleteProject: ({ params }) => projects.delete(params.id),
      rotateProjectKey: ({ params }) => projects.rotateKey(params.id),

      listSubscriptions: () => Effect.map(subscriptions.list, (subscriptions) => ({ subscriptions })),
      registerSubscription: Effect.fn(function*({ payload }) {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* subscriptions.register(payload, request.headers["user-agent"] ?? "")
      }),
      updateSubscription: ({ params, payload }) => subscriptions.update(params.id, payload),
      deleteSubscription: ({ params }) => subscriptions.delete(params.id),

      listSilences: () => silences.listSummary,
      createSilence: ({ payload }) => silences.create(payload),
      getSilence: ({ params }) => silences.get(params.id),
      deleteSilence: ({ params }) => silences.delete(params.id),

      getSettings: () => settings.get,
      updateSettings: ({ payload }) => settings.update(payload),
      status: Effect.fn(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* system.status(requestOrigin(request))
      }),
      testNotification: ({ payload }) => system.testNotification(payload.project_id)
    })
  })
)

export const ApiHandlers = Layer.mergeAll(
  HealthHandlers,
  PublicHandlers,
  IngestHandlers,
  AdminHandlers
)
