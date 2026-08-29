import { Context, Effect, Layer, Redacted } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { CommonErrors } from "./api-models.js"
import { Auth, Projects } from "./application.js"
import type { ProjectRow } from "./types.js"

export class CurrentAdmin extends Context.Service<CurrentAdmin, {
  readonly authenticated: true
}>()("ops-context/CurrentAdmin") {}

export class CurrentProject extends Context.Service<CurrentProject, ProjectRow>()(
  "ops-context/CurrentProject"
) {}

export class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization, {
  provides: CurrentAdmin
}>()("ops-context/AdminAuthorization", {
  error: CommonErrors
}) {}

export class SameOrigin extends HttpApiMiddleware.Service<SameOrigin>()(
  "ops-context/SameOrigin",
  { error: CommonErrors }
) {}

export class ProjectAuthorization extends HttpApiMiddleware.Service<ProjectAuthorization, {
  provides: CurrentProject
}>()("ops-context/ProjectAuthorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: CommonErrors,
  requiredForClient: true
}) {}

export const AdminAuthorizationLive = Layer.effect(
  AdminAuthorization,
  Effect.gen(function*() {
    const auth = yield* Auth
    return AdminAuthorization.of((httpEffect) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        yield* auth.requireAdmin(request)
        return yield* Effect.provideService(
          httpEffect,
          CurrentAdmin,
          { authenticated: true }
        )
      }))
  })
)

export const SameOriginLive = Layer.effect(
  SameOrigin,
  Effect.gen(function*() {
    const auth = yield* Auth
    return SameOrigin.of((httpEffect) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        yield* auth.requireSameOrigin(request)
        return yield* httpEffect
      }))
  })
)

export const ProjectAuthorizationLive = Layer.effect(
  ProjectAuthorization,
  Effect.gen(function*() {
    const projects = yield* Projects
    return ProjectAuthorization.of({
      bearer: (httpEffect, { credential }) =>
        projects.authenticate(Redacted.value(credential)).pipe(
          Effect.flatMap((project) =>
            Effect.provideService(httpEffect, CurrentProject, project)
          )
        )
    })
  })
)
