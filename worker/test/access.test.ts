import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK
} from "jose"
import { Effect, Layer } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import {
  AdministratorIdentity,
  attachCloudflareAccess,
  verifyCloudflareAccessJwtWithJwks,
  type AccessJwtVerifier,
  type AccessPrincipal,
  type ExecutionContextWithAccess
} from "../src/access.js"
import { AppConfig, type ConfigService } from "../src/services.js"
import type { Env } from "../src/types.js"

const teamDomain = "ops-team.cloudflareaccess.com"
const issuer = `https://${teamDomain}`

const config: ConfigService = {
  baseUrl: "https://ops.example.com",
  appOrigin: "https://ops.example.com",
  appHost: "ops.example.com",
  mcpHost: "mcp.ops.example.com",
  accessTeamDomain: teamDomain,
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
  OPS_ACCESS_TEAM_DOMAIN: config.accessTeamDomain,
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

const emptyContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined
} as unknown as ExecutionContextWithAccess

const authenticate = (
  request: Request,
  surface: "app" | "mcp"
): Promise<AccessPrincipal> =>
  Effect.runPromise(
    Effect.flatMap(AdministratorIdentity, (identity) =>
      identity.authenticateRequest(request, surface)
    ).pipe(Effect.provide(identityLayer))
  )

interface SigningKey {
  readonly privateKey: CryptoKey
  readonly publicJwk: JWK
  readonly kid: string
}

let currentKey: SigningKey
let previousKey: SigningKey

const makeKey = async (kid: string): Promise<SigningKey> => {
  const pair = await generateKeyPair("RS256", { extractable: true })
  const publicJwk = await exportJWK(pair.publicKey)
  return {
    privateKey: pair.privateKey,
    publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
    kid
  }
}

const sign = (
  key: SigningKey,
  audience: string,
  claims: Record<string, unknown>,
  expirationTime: string | number = "5m"
): Promise<string> =>
  new SignJWT({ type: "app", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .sign(key.privateKey)

const localVerifier = (jwks: JSONWebKeySet): AccessJwtVerifier =>
  (token, domain, audience) =>
    verifyCloudflareAccessJwtWithJwks(token, domain, audience, jwks)

beforeAll(async () => {
  [currentKey, previousKey] = await Promise.all([
    makeKey("current"),
    makeKey("previous")
  ])
})

describe("Cloudflare Access identity boundary", () => {
  it("accepts a verified user on the configured application host", async () => {
    const request = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status"),
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

  it("verifies the signed Access assertion when Static Assets hides ctx.access", async () => {
    const token = await sign(currentKey, "app-audience", {
      sub: "user-static-router",
      email: "router@example.com",
      name: "Static Router User"
    })
    const request = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status", {
        headers: { "cf-access-jwt-assertion": token }
      }),
      env,
      emptyContext,
      localVerifier({ keys: [currentKey.publicJwk] })
    )

    expect(request.headers.has("cf-access-jwt-assertion")).toBe(false)
    await expect(authenticate(request, "app")).resolves.toMatchObject({
      subject: "user-static-router",
      email: "router@example.com",
      kind: "user",
      audience: "app-audience",
      surface: "app"
    })
  })

  it("supports Access certificate overlap and rejects a key after it is removed", async () => {
    const previousToken = await sign(previousKey, "app-audience", {
      sub: "user-previous",
      email: "previous@example.com"
    })
    const overlapping = localVerifier({
      keys: [currentKey.publicJwk, previousKey.publicJwk]
    })
    const accepted = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status", {
        headers: { "cf-access-jwt-assertion": previousToken }
      }),
      env,
      emptyContext,
      overlapping
    )
    await expect(authenticate(accepted, "app")).resolves.toMatchObject({
      subject: "user-previous"
    })

    const rejected = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status", {
        headers: { "cf-access-jwt-assertion": previousToken }
      }),
      env,
      emptyContext,
      localVerifier({ keys: [currentKey.publicJwk] })
    )
    await expect(authenticate(rejected, "app")).rejects.toMatchObject({
      _tag: "UnauthorizedError"
    })
  })

  it("rejects expired assertions and assertions for another audience", async () => {
    const expired = await sign(currentKey, "app-audience", {
      sub: "expired-user",
      email: "expired@example.com"
    }, Math.floor(Date.now() / 1_000) - 60)
    const wrongAudience = await sign(currentKey, "other-audience", {
      sub: "wrong-audience",
      email: "wrong@example.com"
    })
    const verifier = localVerifier({ keys: [currentKey.publicJwk] })

    for (const token of [expired, wrongAudience]) {
      const request = await attachCloudflareAccess(
        new Request("https://ops.example.com/api/v1/status", {
          headers: { "cf-access-jwt-assertion": token }
        }),
        env,
        emptyContext,
        verifier
      )
      await expect(authenticate(request, "app")).rejects.toMatchObject({
        _tag: "UnauthorizedError"
      })
    }
  })

  it("allows a signed service-token assertion on MCP but not the app", async () => {
    const token = await sign(currentKey, "mcp-audience", {
      sub: "",
      common_name: "ops-context-mcp-client"
    })
    const request = await attachCloudflareAccess(
      new Request("https://mcp.ops.example.com/mcp", {
        headers: { "cf-access-jwt-assertion": token }
      }),
      env,
      emptyContext,
      localVerifier({ keys: [currentKey.publicJwk] })
    )

    await expect(authenticate(request, "mcp")).resolves.toMatchObject({
      subject: "ops-context-mcp-client",
      kind: "service-token",
      surface: "mcp"
    })
  })

  it("rejects a request without a verified Access context", async () => {
    const request = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status"),
      env,
      emptyContext
    )

    await expect(authenticate(request, "app")).rejects.toMatchObject({
      _tag: "UnauthorizedError"
    })
  })

  it("allows the explicit development bypass only on loopback", async () => {
    const localEnv = { ...env, OPS_LOCAL_ACCESS_BYPASS: "1" }
    const local = await attachCloudflareAccess(
      new Request("http://localhost:8787/api/v1/status"),
      localEnv,
      emptyContext
    )
    await expect(authenticate(local, "app")).resolves.toMatchObject({
      subject: "local-development",
      email: "local@localhost",
      kind: "user",
      surface: "app"
    })

    const deployed = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status"),
      localEnv,
      emptyContext
    )
    await expect(authenticate(deployed, "app")).rejects.toMatchObject({
      _tag: "UnauthorizedError"
    })
  })

  it("strips spoofed internal identity headers", async () => {
    const request = await attachCloudflareAccess(
      new Request("https://ops.example.com/api/v1/status", {
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
      emptyContext
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
      emptyContext
    )

    await expect(authenticate(request, "app")).rejects.toMatchObject({
      _tag: "ForbiddenError"
    })
  })
})
