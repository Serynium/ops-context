import { Effect } from "effect"
import { type QueueUnavailable, type RepositoryUnavailable } from "./errors.js"
import { nowIso } from "./ids.js"
import { EventsRepository, PushJobsRepository, SettingsRepository } from "./repositories.js"
import { AppConfig, PushQueue } from "./services.js"
import { getSettings } from "./settings.js"
import type { PushJobMessage } from "./types.js"

export interface MaintenanceResult {
  readonly prunedEvents: number
  readonly recoveredJobs: number
}

export const runMaintenance: Effect.Effect<MaintenanceResult, RepositoryUnavailable | QueueUnavailable, EventsRepository | PushJobsRepository | SettingsRepository | PushQueue | AppConfig> =
  Effect.gen(function*() {
    const events = yield* EventsRepository
    const pushJobs = yield* PushJobsRepository
    const queue = yield* PushQueue
    const now = nowIso()
    const settings = yield* getSettings

    let prunedEvents = 0
    if (settings.retention_days > 0) {
      const cutoff = new Date(Date.now() - settings.retention_days * 86_400_000).toISOString()
      prunedEvents = yield* events.pruneBefore(cutoff)
    }

    const staleQueueTime = new Date(Date.now() - 5 * 60_000).toISOString()
    const messages: ReadonlyArray<PushJobMessage> = yield* pushJobs.listRecoverable(now, staleQueueTime)

    if (messages.length > 0) {
      yield* queue.sendMany(messages)
      const queuedAt = nowIso()
      yield* pushJobs.markRecoveredQueued(messages, queuedAt)
    }

    return {
      prunedEvents,
      recoveredJobs: messages.length
    }
  })
