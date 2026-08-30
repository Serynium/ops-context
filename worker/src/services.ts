import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { buildPushHTTPRequest, type PushMessage, type PushSubscription } from "@pushforge/builder"
import { Context, Crypto, Effect, Layer } from "effect"
import {
  d1FailureTelemetry,
  d1SuccessTelemetry,
  type DatabaseOperation
} from "./database-observability.js"
import { internal, type AppError } from "./errors.js"
import type { Env, PushJobMessage } from "./types.js"

export interface SqlStatement {
  readonly name: string
  readonly sql: string
  readonly params?: ReadonlyArray<unknown>
}

export interface DatabaseService {
  readonly first: <A extends object>(
    name: string,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<A | null, AppError>
  readonly all: <A extends object>(
    name: string,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<A>, AppError>
  readonly run: (
    name: string,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<D1Result<unknown>, AppError>
  readonly batch: (
    name: string,
    statements: ReadonlyArray<SqlStatement>
  ) => Effect.Effect<void, AppError>
}

export class Database extends Context.Service<Database, DatabaseService>()("ops-context/Database") {
  static readonly layer = (db: D1Database): Layer.Layer<Database> => {
    const requireD1Success = <A extends D1Result<unknown>>(result: A): A => {
      if (result.success !== true) throw new Error("D1 operation returned an unsuccessful result")
      return result
    }

    const observe = <A>(
      name: string,
      operation: DatabaseOperation,
      execute: () => Promise<A>,
      successTelemetry: (result: A) => ReadonlyArray<Record<string, unknown>>
    ): Effect.Effect<A, AppError> =>
      Effect.tryPromise({
        try: execute,
        catch: (cause) => internal(`database ${operation} failed`, cause)
      }).pipe(
        Effect.tap((result) =>
          Effect.forEach(successTelemetry(result), (telemetry) =>
            Effect.all([
              Effect.annotateCurrentSpan(telemetry),
              Effect.logInfo(telemetry)
            ], { discard: true }), { discard: true })
        ),
        Effect.tapError(() => {
          const telemetry = d1FailureTelemetry(name, operation)
          return Effect.all([
            Effect.annotateCurrentSpan(telemetry),
            Effect.logError(telemetry)
          ], { discard: true })
        }),
        Effect.withSpan("D1.query", {
          kind: "client",
          attributes: {
            "db.system": "cloudflare-d1",
            "db.query.name": name,
            "db.operation": operation
          }
        })
      )

    const all: DatabaseService["all"] = <A extends object>(
      name: string,
      statement: string,
      params: ReadonlyArray<unknown> = []
    ) =>
      observe(
        name,
        "query",
        async () => requireD1Success(await db.prepare(statement).bind(...params).all<A>()),
        (result) => [d1SuccessTelemetry(name, "query", result)]
      ).pipe(
        Effect.map((result) => result.results ?? [])
      )

    const first: DatabaseService["first"] = <A extends object>(
      name: string,
      statement: string,
      params: ReadonlyArray<unknown> = []
    ) => all<A>(name, statement, params).pipe(Effect.map((rows) => rows[0] ?? null))

    const run: DatabaseService["run"] = (name, statement, params = []) =>
      observe(
        name,
        "write",
        async () => requireD1Success(await db.prepare(statement).bind(...params).run()),
        (result) => [d1SuccessTelemetry(name, "write", result)]
      )

    const batch: DatabaseService["batch"] = (name, statements) => {
      if (statements.length === 0) return Effect.void
      return observe(
        name,
        "batch",
        async () => {
          const results = await db.batch(
            statements.map((statement) => db.prepare(statement.sql).bind(...(statement.params ?? [])))
          )
          return results.map(requireD1Success)
        },
        (results) => results.map((result, index) =>
          d1SuccessTelemetry(statements[index]?.name ?? name, "batch", result)
        )
      ).pipe(
        Effect.asVoid
      )
    }

    return Layer.succeed(Database)(Database.of({ first, all, run, batch }))
  }
}

export interface ConfigService {
  readonly baseUrl?: string
  readonly appOrigin: string
  readonly appHost: string
  readonly mcpHost?: string
  readonly accessAppAudience?: string
  readonly accessMcpAudience?: string
  readonly defaultRetentionDays: number
  readonly maxPushAttempts: number
  readonly vapidPublicKey: string
  readonly vapidPrivateJwk: string
  readonly vapidSubject: string
}

const hostFromUrl = (value: string | undefined): string => {
  if (!value) return ""
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return ""
  }
}

const originFromUrl = (value: string | undefined, host: string): string => {
  if (value) {
    try {
      return new URL(value).origin
    } catch {
      // The empty origin below makes private mutations fail closed.
    }
  }
  return host ? `https://${host}` : ""
}

export class AppConfig extends Context.Service<AppConfig, ConfigService>()("ops-context/AppConfig") {
  static readonly layer = (env: Env): Layer.Layer<AppConfig> => {
    const baseUrl = env.OPS_BASE_URL?.trim()
    const appHost = env.OPS_APP_HOST?.trim().toLowerCase() || hostFromUrl(baseUrl)
    const mcpHost = env.OPS_MCP_HOST?.trim().toLowerCase()
    const accessAppAudience = env.OPS_ACCESS_APP_AUD?.trim()
    const accessMcpAudience = env.OPS_ACCESS_MCP_AUD?.trim()

    return Layer.succeed(AppConfig)({
      ...(baseUrl ? { baseUrl } : {}),
      appOrigin: originFromUrl(baseUrl, appHost),
      appHost,
      ...(mcpHost ? { mcpHost } : {}),
      ...(accessAppAudience ? { accessAppAudience } : {}),
      ...(accessMcpAudience ? { accessMcpAudience } : {}),
      defaultRetentionDays: Number.parseInt(env.OPS_RETENTION_DAYS ?? "90", 10) || 90,
      maxPushAttempts: Math.min(20, Math.max(1, Number.parseInt(env.OPS_PUSH_MAX_ATTEMPTS ?? "6", 10) || 6)),
      vapidPublicKey: env.VAPID_PUBLIC_KEY,
      vapidPrivateJwk: env.VAPID_PRIVATE_JWK,
      vapidSubject: env.VAPID_SUBJECT
    })
  }
}

export interface QueueService {
  readonly send: (message: PushJobMessage) => Effect.Effect<void, AppError>
  readonly sendMany: (messages: ReadonlyArray<PushJobMessage>) => Effect.Effect<void, AppError>
}

export class PushQueue extends Context.Service<PushQueue, QueueService>()("ops-context/PushQueue") {
  static readonly layer = (queue: Queue<PushJobMessage>): Layer.Layer<PushQueue> =>
    Layer.succeed(PushQueue)({
      send: (message) =>
        Effect.tryPromise({
          try: () => queue.send(message),
          catch: (cause) => internal("failed to enqueue push delivery", cause)
        }),
      sendMany: (messages) =>
        Effect.tryPromise({
          try: async () => {
            for (let offset = 0; offset < messages.length; offset += 100) {
              const batch = messages.slice(offset, offset + 100)
              await queue.sendBatch(batch.map((body) => ({ body })))
            }
          },
          catch: (cause) => internal("failed to enqueue push deliveries", cause)
        })
    })
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

export interface CredentialCryptoService {
  readonly randomToken: (bytes?: number) => Effect.Effect<string, AppError>
  readonly sha256Hex: (value: string) => Effect.Effect<string, AppError>
  readonly newId: (prefix: string) => Effect.Effect<string, AppError>
}

export class CredentialCrypto extends Context.Service<CredentialCrypto, CredentialCryptoService>()(
  "ops-context/CredentialCrypto"
) {
  static readonly layerNoDeps = Layer.effect(
    CredentialCrypto,
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const encoder = new TextEncoder()
      const mapCryptoError = Effect.mapError((cause: unknown) => internal("cryptographic operation failed", cause))

      const randomToken: CredentialCryptoService["randomToken"] = (bytes = 32) =>
        crypto.randomBytes(bytes).pipe(
          Effect.map(base64UrlEncode),
          mapCryptoError
        )

      const sha256Hex: CredentialCryptoService["sha256Hex"] = (value) =>
        crypto.digest("SHA-256", encoder.encode(value)).pipe(
          Effect.map(bytesToHex),
          mapCryptoError
        )

      const newId: CredentialCryptoService["newId"] = (prefix) =>
        crypto.randomUUIDv7.pipe(
          Effect.map((id) => `${prefix}_${id.replaceAll("-", "")}`),
          mapCryptoError
        )

      return CredentialCrypto.of({ randomToken, sha256Hex, newId })
    })
  )

  static readonly layer: Layer.Layer<CredentialCrypto> = this.layerNoDeps.pipe(
    Layer.provide(BrowserCrypto.layer)
  )
}

export interface WebPushService {
  readonly send: (
    subscription: PushSubscription,
    message: Omit<PushMessage, "adminContact">
  ) => Effect.Effect<Response, AppError>
}

export class WebPush extends Context.Service<WebPush, WebPushService>()("ops-context/WebPush") {
  static readonly layer = Layer.effect(
    WebPush,
    Effect.gen(function*() {
      const config = yield* AppConfig

      const send: WebPushService["send"] = (subscription, message) =>
        Effect.tryPromise({
          try: async () => {
            const request = await buildPushHTTPRequest({
              privateJWK: config.vapidPrivateJwk,
              subscription,
              message: {
                ...message,
                adminContact: config.vapidSubject
              }
            })
            return fetch(request.endpoint, {
              method: "POST",
              headers: request.headers,
              body: request.body
            })
          },
          catch: (cause) => internal("Web Push request failed", cause)
        }).pipe(Effect.withSpan("WebPush.send", { attributes: { endpoint: new URL(subscription.endpoint).origin } }))

      return WebPush.of({ send })
    })
  )
}

export const InfrastructureLive = (env: Env) =>
  Layer.mergeAll(
    Database.layer(env.DB),
    AppConfig.layer(env),
    PushQueue.layer(env.PUSH_QUEUE),
    CredentialCrypto.layer
  )
