import { Effect } from "effect"
import { type RepositoryUnavailable } from "./errors.js"
import { AppConfig, Database } from "./services.js"
import { getSettings } from "./settings.js"

export interface RetentionResult {
  readonly prunedEvents: number
}

const changes = (result: D1Result<unknown>): number =>
  (result.meta as { readonly changes?: number }).changes ?? 0

export const runRetention: Effect.Effect<RetentionResult, RepositoryUnavailable, Database | AppConfig> =
  Effect.gen(function*() {
    const db = yield* Database
    const settings = yield* getSettings

    let prunedEvents = 0
    if (settings.retention_days > 0) {
      const cutoff = new Date(Date.now() - settings.retention_days * 86_400_000).toISOString()
      const pruned = yield* db.run(
        "events.prune_retention",
        "DELETE FROM events WHERE created_at < ?",
        [cutoff]
      )
      prunedEvents = changes(pruned)
    }

    return { prunedEvents }
  }).pipe(Effect.withSpan("Retention.run"))
