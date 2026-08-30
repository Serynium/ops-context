import { Effect } from "effect"
import { type QueueUnavailable, type RepositoryUnavailable } from "./errors.js"
import { nowIso } from "./ids.js"
import { AppConfig, Database, PushQueue } from "./services.js"
import { getSettings } from "./settings.js"
import type { PushJobMessage } from "./types.js"

interface RecoverableJob {
  readonly event_id: string
  readonly subscription_id: string
}

export interface MaintenanceResult {
  readonly prunedEvents: number
  readonly recoveredJobs: number
}

const changes = (result: D1Result<unknown>): number =>
  (result.meta as { readonly changes?: number }).changes ?? 0

export const runMaintenance: Effect.Effect<MaintenanceResult, RepositoryUnavailable | QueueUnavailable, Database | PushQueue | AppConfig> =
  Effect.gen(function*() {
    const db = yield* Database
    const queue = yield* PushQueue
    const now = nowIso()
    const settings = yield* getSettings

    let prunedEvents = 0
    if (settings.retention_days > 0) {
      const cutoff = new Date(Date.now() - settings.retention_days * 86_400_000).toISOString()
      const pruned = yield* db.run("events.prune_before", "DELETE FROM events WHERE created_at < ?", [cutoff])
      prunedEvents = changes(pruned)
    }

    const staleQueueTime = new Date(Date.now() - 5 * 60_000).toISOString()
    const jobs = yield* db.all<RecoverableJob>(
      "push_jobs.list_recoverable",
      `SELECT event_id, subscription_id
       FROM push_jobs
       WHERE
         (state = 'pending' AND available_at <= ?)
         OR (
           state = 'queued'
           AND available_at <= ?
           AND (queued_at IS NULL OR queued_at < ?)
         )
         OR (
           state = 'sending'
           AND (lease_until IS NULL OR lease_until < ?)
         )
       ORDER BY available_at
       LIMIT 100`,
      [now, now, staleQueueTime, now]
    )

    const messages: ReadonlyArray<PushJobMessage> = jobs.map((job) => ({
      eventId: job.event_id,
      subscriptionId: job.subscription_id
    }))

    if (messages.length > 0) {
      yield* queue.sendMany(messages)
      const queuedAt = nowIso()
      yield* db.batch(
        "push_jobs.mark_recovered_queued",
        messages.map((message) => ({
          name: "push_jobs.mark_recovered_queued",
          sql: `UPDATE push_jobs
                SET state = 'queued', queued_at = ?, lease_until = NULL, dead_at = NULL, updated_at = ?
                WHERE event_id = ? AND subscription_id = ?
                  AND state IN ('pending', 'queued', 'sending', 'retrying')`,
          params: [queuedAt, queuedAt, message.eventId, message.subscriptionId]
        }))
      )
    }

    return {
      prunedEvents,
      recoveredJobs: messages.length
    }
  })
