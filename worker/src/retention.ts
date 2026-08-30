import { Effect } from "effect"
import { type RepositoryUnavailable } from "./errors.js"
import { EventsRepository, SettingsRepository } from "./repositories.js"
import { AppConfig } from "./services.js"
import { getSettings } from "./settings.js"

export interface RetentionResult {
  readonly prunedEvents: number
}

export const runRetention: Effect.Effect<RetentionResult, RepositoryUnavailable, EventsRepository | SettingsRepository | AppConfig> =
  Effect.gen(function*() {
    const events = yield* EventsRepository
    const settings = yield* getSettings

    let prunedEvents = 0
    if (settings.retention_days > 0) {
      const cutoff = new Date(Date.now() - settings.retention_days * 86_400_000).toISOString()
      prunedEvents = yield* events.pruneBefore(cutoff)
    }

    return { prunedEvents }
  }).pipe(Effect.withSpan("Retention.run"))
