import { Effect, Schema } from "effect"
import { CreateEventInputSchema } from "./event-contract.js"
import { invalidEvent, type InvalidEvent } from "./errors.js"

export const QUEUE_COMMAND_VERSION = 1 as const
// Cloudflare measures 1 KB as 1,000 bytes and counts approximately 100 bytes
// of internal metadata against the 128 KB per-message limit.
export const QUEUE_COMMAND_MAX_BYTES = 127_900

const encoder = new TextEncoder()

export const encodedQueueCommandBytes = (command: QueueCommand): number =>
  encoder.encode(JSON.stringify(command)).byteLength

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

export type IngestEventCommand = typeof IngestEventCommandSchema.Type
export type DeliverPushCommand = typeof DeliverPushCommandSchema.Type
export type QueueCommand = typeof QueueCommandSchema.Type

export const decodeQueueCommand = (
  input: unknown
): Effect.Effect<QueueCommand, InvalidEvent> =>
  Effect.gen(function*() {
    if (
      typeof input === "object" && input !== null &&
      ("_tag" in input || "version" in input)
    ) {
      return yield* Schema.decodeUnknownEffect(QueueCommandSchema)(input)
    }

    const legacy = yield* Schema.decodeUnknownEffect(LegacyDeliverPushCommandSchema)(input)
    return {
      _tag: "DeliverPush",
      version: QUEUE_COMMAND_VERSION,
      eventId: legacy.eventId,
      subscriptionId: legacy.subscriptionId
    } as const
  }).pipe(Effect.mapError(() => invalidEvent("invalid Queue command")))
