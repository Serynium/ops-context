import { Effect, FileSystem, Layer, Path } from "effect"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AdministratorIdentity } from "./access.js"
import { ApiHandlers, OpsApi } from "./api.js"
import {
  Events,
  EventIngestion,
  Projects,
  PushDelivery,
  Retention,
  Settings,
  Silences,
  Subscriptions,
  System
} from "./application.js"
import { McpEndpoint } from "./mcp.js"
import {
  AdminAuthorizationLive,
  ProjectAuthorizationLive,
  SameOriginLive
} from "./middleware.js"
import { SentryEndpoint } from "./sentry.js"
import { D1StructuredLoggerLive } from "./database-observability.js"
import { PushDeliveryRepository } from "./push-repository.js"
import { D1RepositoriesLive } from "./repositories.js"
import {
  InfrastructureLive,
  WebPush
} from "./services.js"
import type { Env } from "./types.js"

const securityHeaders = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(
      httpEffect,
      (response) =>
        response.pipe(
          HttpServerResponse.setHeader("cache-control", "no-store"),
          HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
          HttpServerResponse.setHeader("referrer-policy", "same-origin"),
          HttpServerResponse.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()")
        )
    ),
  { global: true }
)

const HttpSupportLive = (() => {
  const fileSystem = FileSystem.layerNoop({})
  const httpPlatform = HttpPlatform.layer.pipe(Layer.provide(fileSystem))
  return Layer.mergeAll(
    fileSystem,
    Path.layer,
    Etag.layerWeak,
    httpPlatform
  )
})()

export const makeLayers = (env: Env) => {
  const infrastructure = Layer.merge(InfrastructureLive(env), D1RepositoriesLive(env.DB))

  const identity = AdministratorIdentity.layer.pipe(
    Layer.provide(infrastructure)
  )

  const domain = Layer.mergeAll(
    Projects.layer,
    Events.layer,
    Subscriptions.layer,
    Silences.layer,
    Settings.layer
  ).pipe(Layer.provide(infrastructure))

  const base = Layer.mergeAll(infrastructure, identity, domain)
  const system = System.layer.pipe(Layer.provide(base))
  const application = Layer.mergeAll(domain, identity, system)

  const middleware = Layer.mergeAll(
    AdminAuthorizationLive,
    SameOriginLive,
    ProjectAuthorizationLive
  ).pipe(Layer.provide(base))

  const handlerDependencies = Layer.mergeAll(application, middleware)
  const handlers = ApiHandlers.pipe(Layer.provide(handlerDependencies))

  const routes = HttpApiBuilder.layer(OpsApi, {
    openapiPath: "/api/v1/openapi.json"
  }).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpSupportLive)
  )

  const http = Layer.mergeAll(routes, securityHeaders).pipe(
    Layer.provide(D1StructuredLoggerLive)
  )

  const webPush = WebPush.layer.pipe(Layer.provide(infrastructure))
  const pushRepository = PushDeliveryRepository.layer.pipe(Layer.provide(infrastructure))
  const delivery = PushDelivery.layer.pipe(
    Layer.provide(Layer.mergeAll(infrastructure, webPush, pushRepository))
  )
  const ingestion = EventIngestion.layer.pipe(Layer.provide(infrastructure))
  const retention = Retention.layer.pipe(Layer.provide(infrastructure))
  const mcp = McpEndpoint.layer.pipe(Layer.provide(base))
  const sentry = SentryEndpoint.layer.pipe(Layer.provide(base))
  const programs = Layer.mergeAll(delivery, ingestion, retention, mcp, sentry).pipe(
    Layer.provide(D1StructuredLoggerLive)
  )

  return { http, programs } as const
}
