import { Effect } from "effect"
import { type RepositoryUnavailable } from "./errors.js"
import { DeliveriesRepository, EventsRepository, SettingsRepository } from "./repositories.js"
import { AppConfig } from "./services.js"
import { getSettings } from "./settings.js"

export const RETENTION_BATCH_SIZE = 500
export const RETENTION_MAX_BATCHES = 20
export const TERMINAL_PUSH_JOB_RETENTION_DAYS = 7
export const SUCCESSFUL_DELIVERY_RETENTION_DAYS = 7

export interface RetentionResult {
  readonly prunedEvents: number
  readonly prunedPushJobs: number
  readonly prunedDeliveries: number
  readonly batches: number
  readonly pushJobBatches: number
  readonly deliveryBatches: number
  readonly continuationRequired: boolean
}

const pruneBatches = <E, R>(
  prune: () => Effect.Effect<number, E, R>
): Effect.Effect<{ readonly pruned: number; readonly batches: number; readonly full: boolean }, E, R> =>
  Effect.gen(function*() {
    let pruned = 0
    let batches = 0
    let last = 0
    while (batches < RETENTION_MAX_BATCHES) {
      last = yield* prune()
      if (last === 0) break
      pruned += last
      batches += 1
      if (last < RETENTION_BATCH_SIZE) break
    }
    return { pruned, batches, full: batches === RETENTION_MAX_BATCHES && last === RETENTION_BATCH_SIZE }
  })

export const runRetention: Effect.Effect<
  RetentionResult,
  RepositoryUnavailable,
  EventsRepository | DeliveriesRepository | SettingsRepository | AppConfig
> = Effect.gen(function*() {
  const events = yield* EventsRepository
  const deliveries = yield* DeliveriesRepository
  const settings = yield* getSettings

  const pushJobCutoff = new Date(
    Date.now() - TERMINAL_PUSH_JOB_RETENTION_DAYS * 86_400_000
  ).toISOString()
  const pushJobs = yield* pruneBatches(() =>
    events.pruneTerminalPushJobsBefore(pushJobCutoff, RETENTION_BATCH_SIZE)
  )

  const deliveryCutoff = new Date(
    Date.now() - SUCCESSFUL_DELIVERY_RETENTION_DAYS * 86_400_000
  ).toISOString()
  const successfulDeliveries = yield* pruneBatches(() =>
    deliveries.pruneSuccessfulBeforeEvent(deliveryCutoff, RETENTION_BATCH_SIZE)
  )
  const eventCutoff = settings.retention_days <= 0
    ? null
    : new Date(Date.now() - settings.retention_days * 86_400_000).toISOString()
  const expiredEvents = eventCutoff === null
    ? { pruned: 0, batches: 0, full: false }
    : yield* pruneBatches(() => events.pruneBefore(eventCutoff, RETENTION_BATCH_SIZE))

  return {
    prunedEvents: expiredEvents.pruned,
    prunedPushJobs: pushJobs.pruned,
    prunedDeliveries: successfulDeliveries.pruned,
    batches: expiredEvents.batches,
    pushJobBatches: pushJobs.batches,
    deliveryBatches: successfulDeliveries.batches,
    continuationRequired: expiredEvents.full || pushJobs.full || successfulDeliveries.full
  }
}).pipe(Effect.withSpan("Retention.run"))
