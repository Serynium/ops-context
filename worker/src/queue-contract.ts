import { Effect, Schema } from "effect"
import { CreateEventInputSchema } from "./event-contract.js"
import { invalidEvent, type InvalidEvent } from "./errors.js"

export const QUEUE_COMMAND_VERSION = 1 as const

export const IngestEventCommandSchema = Schema.Struct({
  _tag: Schema.Literal("IngestEvent"),
  version: Schema.Literal(QUEUE_COMMAND_VERSION),
  eventId: Schema.String,
  projectId: Schema.String,
  acceptedAt: Schema.String,
  event: CreateEventInputSchema
})

export const DeliverPushCommandSchema = Schema.Struct({
  _tag: Schema.Literal("DeliverPush"),
  version: Schema.Literal(QUEUE_COMMAND_VERSION),
  eventId: Schema.String,
  subscriptionId: Schema.String
})

const LegacyDeliverPushCommandSchema = Schema.Struct({
  eventId: Schema.String,
  subscriptionId: Schema.String
})

export const QueueCommandSchema = Schema.Union([
  IngestEventCommandSchema,
  DeliverPushCommandSchema
])

const DecodableQueueCommandSchema = Schema.Union([
  IngestEventCommandSchema,
  DeliverPushCommandSchema,
  LegacyDeliverPushCommandSchema
])

export type IngestEventCommand = typeof IngestEventCommandSchema.Type
export type DeliverPushCommand = typeof DeliverPushCommandSchema.Type
export type QueueCommand = typeof QueueCommandSchema.Type

export const decodeQueueCommand = (
  input: unknown
): Effect.Effect<QueueCommand, InvalidEvent> =>
  Schema.decodeUnknownEffect(DecodableQueueCommandSchema)(input).pipe(
    Effect.map((command): QueueCommand => "_tag" in command
      ? command
      : {
          _tag: "DeliverPush",
          version: QUEUE_COMMAND_VERSION,
          eventId: command.eventId,
          subscriptionId: command.subscriptionId
        }),
    Effect.mapError(() => invalidEvent("invalid Queue command"))
  )
