import { Context, Effect } from "effect"
import { internal, type AppError } from "./errors.js"
import type { Env, PushJobMessage } from "./types.js"

export interface SqlStatement {
  readonly sql: string
  readonly params?: ReadonlyArray<unknown>
}

export interface DatabaseService {
  readonly first: <A>(sql: string, params?: ReadonlyArray<unknown>) => Effect.Effect<A | null, AppError>
  readonly all: <A>(sql: string, params?: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<A>, AppError>
  readonly run: (sql: string, params?: ReadonlyArray<unknown>) => Effect.Effect<D1Result<unknown>, AppError>
  readonly batch: (statements: ReadonlyArray<SqlStatement>) => Effect.Effect<ReadonlyArray<D1Result<unknown>>, AppError>
}

export class Database extends Context.Service<Database, DatabaseService>()("ops-context/Database") {}

export interface ConfigService {
  readonly baseUrl?: string
  readonly adminUser: string
  readonly defaultRetentionDays: number
  readonly adminPasswordHash: string
  readonly vapidPublicKey: string
  readonly vapidPrivateJwk: string
  readonly vapidSubject: string
}

export class AppConfig extends Context.Service<AppConfig, ConfigService>()("ops-context/AppConfig") {}

export interface QueueService {
  readonly send: (message: PushJobMessage) => Effect.Effect<void, AppError>
  readonly sendMany: (messages: ReadonlyArray<PushJobMessage>) => Effect.Effect<void, AppError>
}

export class PushQueue extends Context.Service<PushQueue, QueueService>()("ops-context/PushQueue") {}

const bind = (db: D1Database, sql: string, params: ReadonlyArray<unknown> = []): D1PreparedStatement =>
  db.prepare(sql).bind(...params)

export const makeDatabase = (db: D1Database): DatabaseService => ({
  first: <A>(sql: string, params: ReadonlyArray<unknown> = []) =>
    Effect.tryPromise({
      try: () => bind(db, sql, params).first<A>(),
      catch: (cause) => internal("database query failed", cause)
    }),

  all: <A>(sql: string, params: ReadonlyArray<unknown> = []) =>
    Effect.tryPromise({
      try: async () => {
        const result = await bind(db, sql, params).all<A>()
        if (!result.success) throw new Error(result.error ?? "D1 query failed")
        return result.results ?? []
      },
      catch: (cause) => internal("database query failed", cause)
    }),

  run: (sql: string, params: ReadonlyArray<unknown> = []) =>
    Effect.tryPromise({
      try: async () => {
        const result = await bind(db, sql, params).run()
        if (!result.success) throw new Error(result.error ?? "D1 write failed")
        return result
      },
      catch: (cause) => internal("database write failed", cause)
    }),

  batch: (statements) =>
    Effect.tryPromise({
      try: async () => {
        if (statements.length === 0) return []
        const result = await db.batch(statements.map((statement) => bind(db, statement.sql, statement.params)))
        for (const item of result) {
          if (!item.success) throw new Error(item.error ?? "D1 batch failed")
        }
        return result
      },
      catch: (cause) => internal("database batch failed", cause)
    })
})

export const makeConfig = (env: Env): ConfigService => ({
  ...(env.OPS_BASE_URL ? { baseUrl: env.OPS_BASE_URL } : {}),
  adminUser: env.OPS_ADMIN_USER,
  defaultRetentionDays: Number.parseInt(env.OPS_RETENTION_DAYS ?? "90", 10) || 90,
  adminPasswordHash: env.ADMIN_PASSWORD_HASH,
  vapidPublicKey: env.VAPID_PUBLIC_KEY,
  vapidPrivateJwk: env.VAPID_PRIVATE_JWK,
  vapidSubject: env.VAPID_SUBJECT
})

export const makeQueue = (queue: Queue<PushJobMessage>): QueueService => ({
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
