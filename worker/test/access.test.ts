import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  AdministratorIdentity,
  attachCloudflareAccess,
  type AccessPrincipal,
  type ExecutionContextWithAccess
} from "../src/access.js"
import { AppConfig, type ConfigService } from "../src/services.js"
import type { Env } from "../src/types.js"

const config: ConfigService = {
  baseUrl: "https://ops.example.com",
  appOrigin: "https://ops.example.com",
  appHost: "ops.example.com",
  mcpHost: "mcp.ops.example.com",
  accessAppAudience: "app-audience",
  accessMcpAudience: "mcp-audience",
  defaultRetentionDays: 90,
  maxPushAttempts: 6,
  vapidPublicKey: "test-public-key",
  vapidPrivateJwk: "{}",
  vapidSubject: "mailto:test@example.com"
}

const env = {
  OPS_BASE_URL: config.baseUrl,
  OPS_APP_HOST: config.appHost,
  OPS_MCP_HOST: config.mcpHost,
  OPS_ACCESS_APP_AUD: config.accessAppAudience,
  OPS_ACCESS_MCP_AUD: config.accessMcpAudience
} as Env

const identityLayer = AdministratorIdentity.layer.pipe(
  Layer.provide(Layer.succeed(AppConfig)(config))
)

const context = (
  audience: string,
  principal: { readonly id?: string; readonly email?: string; readonly name?: string } | null
): ExecutionContextWithAccess => ({
  access: {
    aud: audience,
    getIdentity: () => Promise.resolve(principal)
  },
  waitUntil: () => undefined,
  passThroughOnException: () => undefined
}) as unknown as ExecutionContextWithAccess

const authenticate = (
  request: Request,
  surface: "app" | "mcp"
): Promise<AccessPrincipal> =>
  Effect.runPromise(
    Effect.flatMap(AdministratorIdentity, (identity) =>
      identity.authenticateRequest(request, surface)
    ).pipe(Effect.provide(identityLayer))
  )

describe("Cloudflare Access identity boundary", () => {
  it("accepts a verified user on the configured application host", async () => {
    const request = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/access/me"),
      env,
      context("app-audience", {
        id: "user-123",
        email: "operator@example.com",
        name: "Operator"
      })
    )

    await expect(authenticate(request, "app")).resolves.toMatchObject({
      subject: "user-123",
      email: "operator@example.com",
      kind: "user",
      audience: "app-audience",
      surface: "app"
    })
  })

  it("rejects a request without a verified Access context", async () => {
    const request = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/access/me"),
      env,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined
      } as unknown as ExecutionContextWithAccess
    )

    await expect(authenticate(request, "app")).rejects.toMatchObject({
      _tag: "UnauthorizedError"
    })
  })

  it("strips spoofed internal identity headers", async () => {
    const request = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/access/me", {
        headers: {
          "x-ops-access-verified": "1",
          "x-ops-access-subject": "attacker",
          "x-ops-access-kind": "user",
          "x-ops-access-surface": "app",
          "x-ops-access-audience": "app-audience",
          "x-ops-access-email": "attacker@example.com"
        }
      }),
      env,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined
      } as unknown as ExecutionContextWithAccess
    )

    await expect(authenticate(request, "app")).rejects.toMatchObject({
      _tag: "UnauthorizedError"
    })
  })

  it("rejects alternate hosts and mismatched Access audiences", async () => {
    const wrongHost = await attachCloudflareAccess(
      new Request("https://bypass.workers.dev/api/v1/status"),
      env,
      context("app-audience", { email: "operator@example.com" })
    )
    await expect(authenticate(wrongHost, "app")).rejects.toMatchObject({
      _tag: "UnauthorizedError"
    })

    const wrongAudience = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status"),
      env,
      context("other-audience", { email: "operator@example.com" })
    )
    await expect(authenticate(wrongAudience, "app")).rejects.toMatchObject({
      _tag: "UnauthorizedError"
    })
  })

  it("allows service tokens on MCP but not the interactive application", async () => {
    const mcpRequest = await attachCloudflareAccess(
      new Request("https://mcp.ops.example.com/mcp"),
      env,
      context("mcp-audience", null)
    )
    await expect(authenticate(mcpRequest, "mcp")).resolves.toMatchObject({
      kind: "service-token",
      surface: "mcp"
    })

    const appRequest = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status"),
      env,
      context("app-audience", null)
    )
    await expect(authenticate(appRequest, "app")).rejects.toMatchObject({
      _tag: "ForbiddenError"
    })
  })

  it("does not let project bearer credentials authorize private surfaces", async () => {
    const request = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status", {
        headers: { authorization: "Bearer ops_proj_not_an_admin_credential" }
      }),
      env,
      context("app-audience", { email: "operator@example.com" })
    )

    await expect(authenticate(request, "app")).rejects.toMatchObject({
      _tag: "ForbiddenError"
    })
  })
})
