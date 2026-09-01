import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK
} from "jose"
import { beforeAll, describe, expect, it } from "vitest"
import {
  attachCloudflareAccess,
  verifyCloudflareAccessJwtWithJwks,
  type AccessJwtVerifier,
  type ExecutionContextWithAccess
} from "../src/access.js"
import type { Env } from "../src/types.js"

const teamDomain = "ops-team.cloudflareaccess.com"
const issuer = `https://${teamDomain}`
const appAudience = "app-audience"

const env = {
  OPS_BASE_URL: "https://ops.example.com",
  OPS_APP_HOST: "ops.example.com",
  OPS_MCP_HOST: "mcp.ops.example.com",
  OPS_ACCESS_TEAM_DOMAIN: teamDomain,
  OPS_ACCESS_APP_AUD: appAudience,
  OPS_ACCESS_MCP_AUD: "mcp-audience"
} as Env

const emptyContext = {} as ExecutionContextWithAccess

interface SigningKey {
  readonly privateKey: CryptoKey
  readonly publicJwk: JWK
  readonly kid: string
}

let trustedKey: SigningKey
let untrustedKey: SigningKey

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
  tokenIssuer = issuer
): Promise<string> =>
  new SignJWT({
    type: "app",
    sub: "user-fail-closed",
    email: "operator@example.com"
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(tokenIssuer)
    .setAudience(appAudience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key.privateKey)

const localVerifier = (jwks: JSONWebKeySet): AccessJwtVerifier =>
  (token, domain, audience) =>
    verifyCloudflareAccessJwtWithJwks(token, domain, audience, jwks)

const attach = (
  token: string,
  url: string,
  jwks: JSONWebKeySet
): Promise<Request> =>
  attachCloudflareAccess(
    new Request(url, {
      headers: { "cf-access-jwt-assertion": token }
    }),
    env,
    emptyContext,
    localVerifier(jwks)
  )

const expectNotVerified = (request: Request): void => {
  expect(request.headers.has("cf-access-jwt-assertion")).toBe(false)
  expect(request.headers.has("x-ops-access-verified")).toBe(false)
}

beforeAll(async () => {
  [trustedKey, untrustedKey] = await Promise.all([
    makeKey("trusted"),
    makeKey("untrusted")
  ])
})

describe("Cloudflare Access JWT fail-closed validation", () => {
  it("rejects an otherwise valid token from another issuer", async () => {
    const token = await sign(
      trustedKey,
      "https://other-team.cloudflareaccess.com"
    )
    const request = await attach(
      token,
      "https://ops.example.com/api/v1/status",
      { keys: [trustedKey.publicJwk] }
    )

    expectNotVerified(request)
  })

  it("rejects a token whose signing key is missing from the current JWKS", async () => {
    const token = await sign(untrustedKey)
    const request = await attach(
      token,
      "https://ops.example.com/api/v1/status",
      { keys: [trustedKey.publicJwk] }
    )

    expectNotVerified(request)
  })

  it.each([
    "https://ops.example.com/not-private",
    "https://bypass.workers.dev/api/v1/status"
  ])("does not attach a valid identity to the wrong hostname or surface: %s", async (url) => {
    const token = await sign(trustedKey)
    const request = await attach(token, url, {
      keys: [trustedKey.publicJwk]
    })

    expectNotVerified(request)
  })
})
