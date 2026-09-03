import { buildPushHTTPRequest, type PushMessage, type PushSubscription } from "@pushforge/builder"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlSchema } from "effect/unstable/sql"
import { base64UrlEncode, bytesToHex } from "./crypto.js"
import {
  classifyD1SuccessTelemetry,
  d1FailureTelemetry,
  d1SuccessTelemetry,
  type D1SuccessTelemetry,
  type DatabaseOperation
} from "./database-observability.js"
import {
  cryptographyUnavailable,
  deliveryTemporarilyUnavailable,
  queueUnavailable,
  repositoryUnavailable,
  type CryptographyUnavailable,
  type DeliveryTemporarilyUnavailable,
  type QueueUnavailable,
  type RepositoryUnavailable
} from "./errors.js"
import type { QueueCommand } from "./queue-contract.js"
import type { Env } from "./types.js"

export interface SqlStatement {
  readonly name?: string
  readonly sql: string
  readonly params?: ReadonlyArray<unknown>
}

export interface DatabaseService {
  readonly all: <A>(
    schema: Schema.Schema<A>,
    sql: string,
    params: ReadonlyArray<unknown>,
    name: string
  ) => Effect.Effect<ReadonlyArray<A>, RepositoryUnavailable>
  readonly first: <A>(
    schema: Schema.Schema<A>,
    sql: string,
    params: ReadonlyArray<unknown>,
    name: string
  ) => Effect.Effect<A | null, RepositoryUnavailable>
  readonly run: (
    sql: string,
    params: ReadonlyArray<unknown>,
    name: string
  ) => Effect.Effect<number, RepositoryUnavailable>
  readonly runCounted: (
    sql: string,
    params: ReadonlyArray<unknown>,
    name: string
  ) => Effect.Effect<number, RepositoryUnavailable>
  readonly batch: (
    statements: ReadonlyArray<SqlStatement>,
    name: string
  ) => Effect.Effect<void, RepositoryUnavailable>
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
      successTelemetry: (result: A) => ReadonlyArray<D1SuccessTelemetry>
    ): Effect.Effect<A, RepositoryUnavailable> =>
      Effect.tryPromise({
        try: execute,
        catch: (cause) => repositoryUnavailable(`database ${operation} failed`, cause)
      }).pipe(
        Effect.tap((result) =>
  Effect.forEach(successTelemetry(result), (telemetry) => {
    const decision = classifyD1SuccessTelemetry(telemetry)
    const log = decision === "warning"
      ? Effect.logWarning(telemetry)
      : decision === "info"
        ? Effect.logInfo(telemetry)
        : Effect.void
    return Effect.all([
      Effect.annotateCurrentSpan(telemetry),
      log
    ], { discard: true })
  }, { discard: true })
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

    const query = <A extends object>(
      name: string,
      statement: string,
      params: ReadonlyArray<unknown> = []
    ) =>
      observe(
        name,
        "query",
        async () => requireD1Success(await db.prepare(statement).bind(...params).all<A>()),
        (result) => [d1SuccessTelemetry(name, "query", result)]
      ).pipe(Effect.map((result) => (result.results ?? []) as ReadonlyArray<A>))

    const execute = (name: string, statement: string, params: ReadonlyArray<unknown> = []) =>
      observe(
        name,
        "write",
        async () => requireD1Success(await db.prepare(statement).bind(...params).run()),
        (result) => [d1SuccessTelemetry(name, "write", result)]
      )

    const batchResults = (name: string, statements: ReadonlyArray<SqlStatement>) => {
      if (statements.length === 0) return Effect.succeed([])
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
      )
    }
    const mapRepositoryFailure = (operation: "read" | "write" | "batch" | "decode") =>
      Effect.mapError((_cause: unknown) => repositoryUnavailable(`repository ${operation} failed`))
    const queryRecords = (statement: string, params: ReadonlyArray<unknown>, name: string) =>
      query<Record<string, unknown>>(name, statement, params)
    const all: DatabaseService["all"] = <A>(
      schema: Schema.Schema<A>,
      statement: string,
      params: ReadonlyArray<unknown>,
      name: string
    ) => SqlSchema.findAll({
      Request: Schema.Void,
      Result: schema,
      execute: () => queryRecords(statement, params, name)
    })(undefined).pipe(mapRepositoryFailure("read")) as unknown as Effect.Effect<ReadonlyArray<A>, RepositoryUnavailable>
    const first: DatabaseService["first"] = <A>(
      schema: Schema.Schema<A>,
      statement: string,
      params: ReadonlyArray<unknown>,
      name: string
    ) => SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: schema,
      execute: () => queryRecords(statement, params, name)
    })(undefined).pipe(
      Effect.map(Option.getOrNull),
      mapRepositoryFailure("read")
    ) as Effect.Effect<A | null, RepositoryUnavailable>
    const run: DatabaseService["run"] = (statement, params, name) =>
      execute(name, statement, params).pipe(
        Effect.map((result) => (result.meta as { readonly changes?: number }).changes ?? 0),
        mapRepositoryFailure("write")
      )
    const runCounted: DatabaseService["runCounted"] = (statement, params, name) =>
      batchResults(name, [
        { name, sql: statement, params },
        { name: `${name}.count`, sql: "SELECT changes() AS count" }
      ]).pipe(
        Effect.flatMap((results) => {
          const count = (results[1]?.results?.[0] as { readonly count?: unknown } | undefined)?.count
          return typeof count === "number"
            ? Effect.succeed(count)
            : Effect.fail(repositoryUnavailable("repository decode failed"))
        }),
        mapRepositoryFailure("write")
      )
    const batch: DatabaseService["batch"] = (statements, name) =>
      batchResults(name, statements)
        .pipe(Effect.asVoid)
        .pipe(mapRepositoryFailure("batch"))

    return Layer.succeed(Database)(Database.of({
      all,
      first,
      run,
      runCounted,
      batch
    }))
  }
}

export interface ConfigService {
  readonly baseUrl?: string
  readonly appOrigin: string
  readonly appHost: string
readonly mcpHost?: string
readonly accessTeamDomain?: string
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
const accessTeamDomain = env.OPS_ACCESS_TEAM_DOMAIN?.trim().toLowerCase()
const accessAppAudience = env.OPS_ACCESS_APP_AUD?.trim()
    const accessMcpAudience = env.OPS_ACCESS_MCP_AUD?.trim()

    return Layer.succeed(AppConfig)({
      ...(baseUrl ? { baseUrl } : {}),
      appOrigin: originFromUrl(baseUrl, appHost),
      appHost,
      ...(mcpHost ? { mcpHost } : {}),
...(accessTeamDomain ? { accessTeamDomain } : {}),
...(accessAppAudience ? { accessAppAudience } : {}),
      ...(accessMcpAudience ? { accessMcpAudience } : {}),
      defaultRetentionDays: Number.parseInt(env.OPS_RETENTION_DAYS ?? "90", 10) || 90,
      // The primary Queue permits five retries after the first delivery.
maxPushAttempts: Math.min(6, Math.max(1, Number.parseInt(env.OPS_PUSH_MAX_ATTEMPTS ?? "6", 10) || 6)),
      vapidPublicKey: env.VAPID_PUBLIC_KEY,
      vapidPrivateJwk: env.VAPID_PRIVATE_JWK,
      vapidSubject: env.VAPID_SUBJECT
    })
  }
}

export interface QueueService {
  readonly send: (message: QueueCommand) => Effect.Effect<void, QueueUnavailable>
  readonly sendMany: (messages: ReadonlyArray<QueueCommand>) => Effect.Effect<void, QueueUnavailable>
}

export class PushQueue extends Context.Service<PushQueue, QueueService>()("ops-context/PushQueue") {
  static readonly layer = (queue: Queue<QueueCommand>): Layer.Layer<PushQueue> =>
    Layer.succeed(PushQueue)({
      send: (message) =>
        Effect.tryPromise({
          try: () => queue.send(message),
          catch: (cause) => queueUnavailable("Queue did not accept the command; retry the request", cause)
        }),
      sendMany: (messages) =>
        Effect.tryPromise({
          try: async () => {
            for (let offset = 0; offset < messages.length; offset += 100) {
              const batch = messages.slice(offset, offset + 100)
              await queue.sendBatch(batch.map((body) => ({ body })))
            }
          },
          catch: (cause) => queueUnavailable("Queue did not accept the commands; retry the request", cause)
        })
    })
}

export interface CredentialCryptoService {
  readonly randomToken: (bytes?: number) => Effect.Effect<string, CryptographyUnavailable>
  readonly sha256Hex: (value: string) => Effect.Effect<string, CryptographyUnavailable>
  readonly newId: (prefix: string) => Effect.Effect<string, CryptographyUnavailable>
}

export class CredentialCrypto extends Context.Service<CredentialCrypto, CredentialCryptoService>()(
  "ops-context/CredentialCrypto"
) {
  static readonly layer = Layer.succeed(CredentialCrypto)({
    randomToken: (bytes = 32) => Effect.try({
      try: () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes))),
      catch: (cause) => cryptographyUnavailable("cryptographic operation failed", cause)
    }),
    sha256Hex: (value) => Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      catch: (cause) => cryptographyUnavailable("cryptographic operation failed", cause)
    }).pipe(Effect.map((value) => bytesToHex(new Uint8Array(value)))),
    newId: (prefix) => Effect.try({
      try: () => `${prefix}_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))}`,
      catch: (cause) => cryptographyUnavailable("cryptographic operation failed", cause)
    })
  })
}

export const sha256Hex = (value: string): Effect.Effect<string, CryptographyUnavailable, CredentialCrypto> =>
  Effect.flatMap(CredentialCrypto, (service) => service.sha256Hex(value))

export const randomToken = (bytes = 32): Effect.Effect<string, CryptographyUnavailable, CredentialCrypto> =>
  Effect.flatMap(CredentialCrypto, (service) => service.randomToken(bytes))

export interface WebPushService {
  readonly send: (
    subscription: PushSubscription,
    message: Omit<PushMessage, "adminContact">
  ) => Effect.Effect<Response, DeliveryTemporarilyUnavailable>
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
          catch: (cause) => deliveryTemporarilyUnavailable("Web Push request failed", cause)
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
