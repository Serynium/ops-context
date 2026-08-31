import { readFile, writeFile } from "node:fs/promises"

const replaceRequired = async (path, oldValue, newValue) => {
  const content = await readFile(path, "utf8")
  if (content.includes(newValue)) return
  if (!content.includes(oldValue)) {
    throw new Error(`Missing expected generated text in ${path}`)
  }
  await writeFile(path, content.replace(oldValue, newValue))
}

await replaceRequired(
  "worker/src/database-observability.ts",
  'logLevel === "Warning"',
  'logLevel === "Warn"'
)

await replaceRequired(
  "worker/src/services.ts",
  `import {
  classifyD1SuccessTelemetry,
  d1FailureTelemetry,
  d1SuccessTelemetry,
  type DatabaseOperation
} from "./database-observability.js"`,
  `import {
  classifyD1SuccessTelemetry,
  d1FailureTelemetry,
  d1SuccessTelemetry,
  type D1SuccessTelemetry,
  type DatabaseOperation
} from "./database-observability.js"`
)

await replaceRequired(
  "worker/src/services.ts",
  "successTelemetry: (result: A) => ReadonlyArray<Record<string, unknown>>",
  "successTelemetry: (result: A) => ReadonlyArray<D1SuccessTelemetry>"
)

const outcome = `export type IngestDeadLetterOutcome =
  | { readonly _tag: "Recovered" }
  | { readonly _tag: "Terminalized" }`
const eventsPath = "worker/src/events.ts"
let events = await readFile(eventsPath, "utf8")
while (events.includes(`${outcome}\n\n${outcome}`)) {
  events = events.replace(`${outcome}\n\n${outcome}`, outcome)
}
if ((events.match(/export type IngestDeadLetterOutcome/gu) ?? []).length !== 1) {
  throw new Error("Expected exactly one IngestDeadLetterOutcome declaration")
}
await writeFile(eventsPath, events)

await replaceRequired(
  "worker/src/index.ts",
  `        if (command._tag === "IngestEvent") {
          const outcome = await runtime.runPromise(
            Effect.flatMap(EventIngestion, (ingestion) =>
              deadLetterBatch ? ingestion.deadLetter(command) : ingestion.process(command)
            )
          )
          if (deadLetterBatch) {
            const telemetry = {
              event: outcome._tag === "Terminalized"
                ? "queue.dlq.terminalized"
                : "queue.dlq.recovered",
              queue: batch.queue,
              command: command._tag,
              event_id: command.eventId,
              project_id: command.projectId
            }
            if (outcome._tag === "Terminalized") console.error(telemetry)
            else console.warn(telemetry)
          }
          message.ack()
          continue
        }`,
  `        if (command._tag === "IngestEvent") {
          if (deadLetterBatch) {
            const outcome = await runtime.runPromise(
              Effect.flatMap(EventIngestion, (ingestion) =>
                ingestion.deadLetter(command)
              )
            )
            const telemetry = {
              event: outcome._tag === "Terminalized"
                ? "queue.dlq.terminalized"
                : "queue.dlq.recovered",
              queue: batch.queue,
              command: command._tag,
              event_id: command.eventId,
              project_id: command.projectId
            }
            if (outcome._tag === "Terminalized") console.error(telemetry)
            else console.warn(telemetry)
            message.ack()
            continue
          }

          await runtime.runPromise(
            Effect.flatMap(EventIngestion, (ingestion) =>
              ingestion.process(command)
            )
          )
          message.ack()
          continue
        }`
)
