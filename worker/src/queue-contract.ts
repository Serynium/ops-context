import { Effect, Schema } from "effect"
import { CreateEventInputSchema, EventOccurredAt } from "./event-contract.js"
import { invalidEvent, type InvalidEvent } from "./errors.js"

export const QUEUE_COMMAND_VERSION = 1 as const
export const QUEUE_COMMAND_MAX_BYTES = 63_800

const encoder = new TextEncoder()

export const encodedQueueCommandBytes = (command: QueueCommand): number =>
  encoder.encode(JSON.stringify(command)).byteLength

export const IngestEventCommandSchema = Schema.Struct({
  _tag: Schema.Literal("IngestEvent"),
  version: Schema.Literal(QUEUE_COMMAND_VERSION),
  eventId: Schema.String,
  projectId: Schema.String,
  acceptedAt: EventOccurredAt,
  event: CreateEventInputSchema
})

export const DeliverPushCommandSchema = Schema.Struct({
  _tag: Schema.Literal("DeliverPush"),
  version: Schema.Literal(QUEUE_COMMAND_VERSION),
  eventId: Schema.String,
  subscriptionId: Schema.String
})

export const QueueCommandSchema = Schema.Union([
  IngestEventCommandSchema,
  DeliverPushCommandSchema
])

export type IngestEventCommand = typeof IngestEventCommandSchema.Type
export type DeliverPushCommand = typeof DeliverPushCommandSchema.Type
export type QueueCommand = typeof QueueCommandSchema.Type

export const decodeQueueCommand = (
  input: unknown
): Effect.Effect<QueueCommand, InvalidEvent> =>
  Schema.decodeUnknownEffect(QueueCommandSchema)(input).pipe(
    Effect.mapError(() => invalidEvent("invalid Queue command"))
  )
