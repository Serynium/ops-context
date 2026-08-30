import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { D1Client } from "@effect/sql-d1"
import { buildPushHTTPRequest, type PushMessage, type PushSubscription } from "@pushforge/builder"
import { Context, Crypto, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { internal, type AppError } from "./errors.js"
import type { Env, PushJobMessage } from "./types.js"

export interface SqlStatement {
  readonly sql: string
  readonly params?: ReadonlyArray<unknown>
}

export interface DatabaseService {
  readonly namedAll: <A extends object>(
    name: string,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<A>, AppError>
  readonly first: <A extends object>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<A | null, AppError>
  readonly all: <A extends object>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<A>, AppError>
  readonly run: (
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<D1Result<unknown>, AppError>
  readonly batch: (statements: ReadonlyArray<SqlStatement>) => Effect.Effect<void, AppError>
}

export class Database extends Context.Service<Database, DatabaseService>()("ops-context/Database") {
  static readonly layerNoDeps = Layer.effect(
    Database,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const d1 = yield* D1Client.D1Client

      const sqlFailure = (operation: string) =>
        Effect.mapError((cause: unknown) => internal(`database ${operation} failed`, cause))

      const namedAll: DatabaseService["namedAll"] = <A extends object>(
        name: string,
        statement: string,
        params: ReadonlyArray<unknown> = []
      ) =>
        Effect.tryPromise({
          try: async () => {
            const startedAt = performance.now()
            const result = await d1.config.db.prepare(statement).bind(...params).all<A>()
            if (!result.success) throw new Error(result.error ?? "D1 query failed")

            console.info(JSON.stringify({
              event: "d1_query",
              query: name,
              duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
              rows_returned: result.results.length,
              rows_read: result.meta.rows_read ?? null,
              rows_written: result.meta.rows_written ?? null
            }))

            return result.results
          },
          catch: (cause) => internal(`database query ${name} failed`, cause)
        })

      const first: DatabaseService["first"] = <A extends object>(
        statement: string,
        params: ReadonlyArray<unknown> = []
      ) =>
        sql.unsafe<A>(statement, params).pipe(
          Effect.map((rows) => rows[0] ?? null),
          sqlFailure("query")
        )

      const all: DatabaseService["all"] = <A extends object>(
        statement: string,
        params: ReadonlyArray<unknown> = []
      ) =>
        sql.unsafe<A>(statement, params).pipe(
          Effect.map((rows) => rows as ReadonlyArray<A>),
          sqlFailure("query")
        )

      const run: DatabaseService["run"] = (statement, params = []) =>
        Effect.tryPromise({
          try: async () => {
            const result = await d1.config.db.prepare(statement).bind(...params).run()
            if (!result.success) throw new Error(result.error ?? "D1 write failed")
            return result
          },
          catch: (cause) => internal("database write failed", cause)
        })

      const batch: DatabaseService["batch"] = (statements) => {
        if (statements.length === 0) return Effect.void
        return d1.batch(
          statements.map((statement) =>
            sql.unsafe<Record<string, unknown>>(statement.sql, statement.params)
          )
        ).pipe(
          Effect.asVoid,
          sqlFailure("batch")
        )
      }

      return Database.of({ namedAll, first, all, run, batch })
    })
  )

  static readonly layer = (db: D1Database): Layer.Layer<Database> =>
    this.layerNoDeps.pipe(
      Layer.provide(D1Client.layer({ db })),
      Layer.orDie
    )
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
