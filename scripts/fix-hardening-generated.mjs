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

const observabilityTestPath = "worker/test/database-observability.test.ts"
let observabilityTests = await readFile(observabilityTestPath, "utf8")
const sampledTest = 'it("samples routine successes but always logs expensive queries"'
const remoteTest = 'it("records remote serving location without inventing local values"'
let firstSample = observabilityTests.indexOf(sampledTest)
let duplicateSample = firstSample >= 0
  ? observabilityTests.indexOf(sampledTest, firstSample + sampledTest.length)
  : -1
while (duplicateSample >= 0) {
  const nextRemoteTest = observabilityTests.indexOf(remoteTest, duplicateSample)
  if (nextRemoteTest < 0) {
    throw new Error("Could not locate the test following duplicated sampling coverage")
  }
  observabilityTests =
    observabilityTests.slice(0, duplicateSample) +
    observabilityTests.slice(nextRemoteTest)
  firstSample = observabilityTests.indexOf(sampledTest)
  duplicateSample = observabilityTests.indexOf(
    sampledTest,
    firstSample + sampledTest.length
  )
}
if ((observabilityTests.match(/samples routine successes but always logs expensive queries/gu) ?? []).length !== 1) {
  throw new Error("Expected exactly one D1 success sampling test")
}

const replaceInsideTest = (title, nextTitle, oldValue, newValue) => {
  const start = observabilityTests.indexOf(`it("${title}"`)
  const end = observabilityTests.indexOf(`it("${nextTitle}"`, start + 1)
  if (start < 0 || end < 0) throw new Error(`Could not locate test section: ${title}`)
  const section = observabilityTests.slice(start, end)
  if (!section.includes(oldValue)) {
    if (section.includes(newValue)) return
    throw new Error(`Missing expected value in test section: ${title}`)
  }
  observabilityTests =
    observabilityTests.slice(0, start) +
    section.replace(oldValue, newValue) +
    observabilityTests.slice(end)
}

replaceInsideTest(
  "extracts row counts and prefers the precise SQL duration",
  "samples routine successes but always logs expensive queries",
  '"db.rows_read": 1000,',
  '"db.rows_read": 12,'
)
replaceInsideTest(
  "forwards telemetry as a top-level structured console record",
  "classifies failures without logging driver error messages",
  '"db.rows_read": 12',
  '"db.rows_read": 1000'
)
await writeFile(observabilityTestPath, observabilityTests)
