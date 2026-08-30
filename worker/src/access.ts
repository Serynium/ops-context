import { Context, Effect, Layer } from "effect"
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import {
  ForbiddenError,
  UnauthorizedError,
  type ApiFailure
} from "./api-models.js"
import { AppConfig } from "./services.js"
import type { Env } from "./types.js"

const ACCESS_VERIFIED = "x-ops-access-verified"
const ACCESS_SURFACE = "x-ops-access-surface"
const ACCESS_AUDIENCE = "x-ops-access-audience"
const ACCESS_KIND = "x-ops-access-kind"
const ACCESS_SUBJECT = "x-ops-access-subject"
const ACCESS_EMAIL = "x-ops-access-email"
const ACCESS_NAME = "x-ops-access-name"

const internalHeaders = [
  ACCESS_VERIFIED,
  ACCESS_SURFACE,
  ACCESS_AUDIENCE,
  ACCESS_KIND,
  ACCESS_SUBJECT,
  ACCESS_EMAIL,
  ACCESS_NAME
] as const

export type AccessSurface = "app" | "mcp"
export type AccessPrincipalKind = "user" | "service-token"

export interface AccessPrincipal {
  readonly subject: string
  readonly kind: AccessPrincipalKind
  readonly audience: string
  readonly surface: AccessSurface
  readonly email?: string
  readonly name?: string
}

export interface CloudflareAccessIdentity {
  readonly id?: string
  readonly sub?: string
  readonly email?: string
  readonly name?: string
  readonly common_name?: string
}

export interface CloudflareAccessContext {
  readonly aud: string
  readonly getIdentity: () => Promise<CloudflareAccessIdentity | null>
}

export type ExecutionContextWithAccess = ExecutionContext & {
  readonly access?: CloudflareAccessContext
}

const normalizedHost = (value: string | undefined): string =>
  (value ?? "").trim().toLowerCase()

const hostFromBaseUrl = (value: string | undefined): string => {
  if (!value) return ""
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return ""
  }
}

const appHostFromEnv = (env: Env): string =>
  normalizedHost(env.OPS_APP_HOST) || hostFromBaseUrl(env.OPS_BASE_URL)

const surfaceFor = (request: Request, env: Env): AccessSurface | undefined => {
  const url = new URL(request.url)
  const host = url.host.toLowerCase()
  if (host === appHostFromEnv(env) && url.pathname.startsWith("/api/")) return "app"
  if (
    env.OPS_MCP_HOST &&
    host === normalizedHost(env.OPS_MCP_HOST) &&
    url.pathname === "/mcp"
  ) return "mcp"
  return undefined
}

const audienceFor = (surface: AccessSurface, env: Env): string | undefined =>
  surface === "app" ? env.OPS_ACCESS_APP_AUD : env.OPS_ACCESS_MCP_AUD

const recreateRequest = (request: Request, headers: Headers): Request =>
  new Request(request, { headers })

/**
 * Converts Cloudflare's validated `ctx.access` identity into private headers
 * consumed by the Effect application. All caller-supplied copies of those
 * headers are removed first, so they are never a trust boundary by themselves.
 */
export const attachCloudflareAccess = async (
  request: Request,
  env: Env,
  context: ExecutionContextWithAccess
): Promise<Request> => {
  const headers = new Headers(request.headers)
  const suppliedInternalHeader = internalHeaders.some((name) => headers.has(name))
  for (const name of internalHeaders) headers.delete(name)

  const surface = surfaceFor(request, env)
  const access = (context as { readonly access?: CloudflareAccessContext }).access
  if (!surface || !access) {
    return suppliedInternalHeader ? recreateRequest(request, headers) : request
  }

  const expectedAudience = audienceFor(surface, env)?.trim()
  if (!expectedAudience || access.aud !== expectedAudience) {
    return recreateRequest(request, headers)
  }

  const identity = await access.getIdentity().catch(() => null)
  const email = identity?.email?.trim()
  const name = identity?.name?.trim() || identity?.common_name?.trim()
  const subject = identity?.id?.trim() || identity?.sub?.trim() || email || `service:${access.aud}`
  const kind: AccessPrincipalKind = email ? "user" : "service-token"

  headers.set(ACCESS_VERIFIED, "1")
  headers.set(ACCESS_SURFACE, surface)
  headers.set(ACCESS_AUDIENCE, access.aud)
  headers.set(ACCESS_KIND, kind)
  headers.set(ACCESS_SUBJECT, subject)
  if (email) headers.set(ACCESS_EMAIL, email)
  if (name) headers.set(ACCESS_NAME, name)

  return recreateRequest(request, headers)
}

interface HeaderView {
  readonly get: (name: string) => string | undefined
  readonly host: string
  readonly authorization?: string
}

const fromHttpRequest = (request: HttpServerRequest): HeaderView => ({
  get: (name) => request.headers[name],
  host: normalizedHost(request.headers["x-forwarded-host"] ?? request.headers.host),
  ...(request.headers.authorization ? { authorization: request.headers.authorization } : {})
})

const fromWebRequest = (request: Request): HeaderView => {
  const authorization = request.headers.get("authorization")
  return {
    get: (name) => request.headers.get(name) ?? undefined,
    host: new URL(request.url).host.toLowerCase(),
    ...(authorization ? { authorization } : {})
  }
}

export interface AdministratorIdentityService {
  readonly authenticateHttp: (
    request: HttpServerRequest,
    surface?: AccessSurface
  ) => Effect.Effect<AccessPrincipal, ApiFailure>
  readonly authenticateRequest: (
    request: Request,
    surface?: AccessSurface
  ) => Effect.Effect<AccessPrincipal, ApiFailure>
  readonly requireSameOrigin: (request: HttpServerRequest) => Effect.Effect<void, ApiFailure>
}

export class AdministratorIdentity extends Context.Service<
  AdministratorIdentity,
  AdministratorIdentityService
>()("ops-context/AdministratorIdentity") {
  static readonly layer = Layer.effect(
    AdministratorIdentity,
    Effect.gen(function*() {
      const config = yield* AppConfig

      const authenticate = (
        headers: HeaderView,
        requiredSurface: AccessSurface
      ): Effect.Effect<AccessPrincipal, ApiFailure> =>
        Effect.gen(function*() {
          const verified = headers.get(ACCESS_VERIFIED) === "1"
          const surface = headers.get(ACCESS_SURFACE)
          const audience = headers.get(ACCESS_AUDIENCE)?.trim()
          const kind = headers.get(ACCESS_KIND)
          const subject = headers.get(ACCESS_SUBJECT)?.trim()
          const email = headers.get(ACCESS_EMAIL)?.trim()
          const name = headers.get(ACCESS_NAME)?.trim()

          if (!verified) {
            if (headers.authorization?.startsWith("Bearer ")) {
              return yield* new ForbiddenError({
                error: "forbidden",
                message: "project credentials cannot authorize private surfaces"
              })
            }
            return yield* new UnauthorizedError({
              error: "unauthorized",
              message: "Cloudflare Access authentication is required"
            })
          }

          const expectedHost = requiredSurface === "app" ? config.appHost : config.mcpHost
          const expectedAudience = requiredSurface === "app"
            ? config.accessAppAudience
            : config.accessMcpAudience

          if (
            !expectedHost ||
            headers.host !== expectedHost ||
            surface !== requiredSurface ||
            !expectedAudience ||
            audience !== expectedAudience ||
            !subject ||
            (kind !== "user" && kind !== "service-token")
          ) {
            return yield* new ForbiddenError({
              error: "forbidden",
              message: "the Cloudflare Access identity is not valid for this surface"
            })
          }

          if (requiredSurface === "app" && (kind !== "user" || !email)) {
            return yield* new ForbiddenError({
              error: "forbidden",
              message: "administrator access requires a Cloudflare Access user identity"
            })
          }

          return {
            subject,
            kind: kind as AccessPrincipalKind,
            audience,
            surface: requiredSurface,
            ...(email ? { email } : {}),
            ...(name ? { name } : {})
          }
        }).pipe(Effect.withSpan("AdministratorIdentity.authenticate"))

      const requireSameOrigin = Effect.fn("AdministratorIdentity.requireSameOrigin")(
        function*(request: HttpServerRequest) {
          const origin = request.headers.origin
          if (!origin) return
          if (!config.appOrigin || origin !== config.appOrigin) {
            return yield* new ForbiddenError({
              error: "forbidden",
              message: "cross-origin administrative requests are not allowed"
            })
          }
        }
      )

      return AdministratorIdentity.of({
        authenticateHttp: (request, surface = "app") =>
          authenticate(fromHttpRequest(request), surface),
        authenticateRequest: (request, surface = "mcp") =>
          authenticate(fromWebRequest(request), surface),
        requireSameOrigin
      })
    })
  )

  static testLayer = (principal: AccessPrincipal): Layer.Layer<AdministratorIdentity> =>
    Layer.succeed(AdministratorIdentity)({
      authenticateHttp: () => Effect.succeed(principal),
      authenticateRequest: () => Effect.succeed(principal),
      requireSameOrigin: () => Effect.void
    })
}
