import { Effect } from "effect"
import { type RepositoryUnavailable } from "./errors.js"
import { EventsRepository, SettingsRepository } from "./repositories.js"
import { AppConfig } from "./services.js"
import { getSettings } from "./settings.js"

export const RETENTION_BATCH_SIZE = 500
export const RETENTION_MAX_BATCHES = 20

export interface RetentionResult {
  readonly prunedEvents: number
  readonly batches: number
  readonly continuationRequired: boolean
}

export const runRetention: Effect.Effect<
  RetentionResult,
  RepositoryUnavailable,
  EventsRepository | SettingsRepository | AppConfig
> = Effect.gen(function*() {
  const events = yield* EventsRepository
  const settings = yield* getSettings

  if (settings.retention_days <= 0) {
    return { prunedEvents: 0, batches: 0, continuationRequired: false }
  }

  const cutoff = new Date(
    Date.now() - settings.retention_days * 86_400_000
  ).toISOString()

  let prunedEvents = 0
  let batches = 0
  let lastBatch = 0

  while (batches < RETENTION_MAX_BATCHES) {
    lastBatch = yield* events.pruneBefore(cutoff, RETENTION_BATCH_SIZE)
    if (lastBatch === 0) break

    prunedEvents += lastBatch
    batches += 1
    if (lastBatch < RETENTION_BATCH_SIZE) break
  }

  return {
    prunedEvents,
    batches,
    continuationRequired:
      batches === RETENTION_MAX_BATCHES &&
      lastBatch === RETENTION_BATCH_SIZE
  }
}).pipe(Effect.withSpan("Retention.run"))
