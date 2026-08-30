import { Logger } from "effect"

export type DatabaseOperation = "query" | "write" | "batch"

interface D1Metadata {
  readonly duration?: unknown
  readonly rows_read?: unknown
  readonly rows_written?: unknown
  readonly served_by_region?: unknown
  readonly served_by_primary?: unknown
  readonly timings?: {
    readonly sql_duration_ms?: unknown
  }
}

interface D1ResultLike {
  readonly meta?: D1Metadata
  readonly results?: ReadonlyArray<unknown>
}

const nonNegativeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0

export const d1SuccessTelemetry = (
  queryName: string,
  operation: DatabaseOperation,
  result: D1ResultLike
) => {
  const region = result.meta?.served_by_region
  const primary = result.meta?.served_by_primary
  return {
    event: "d1.query",
    "db.system": "cloudflare-d1",
    "db.query.name": queryName,
    "db.operation": operation,
    "db.rows_returned": result.results?.length ?? 0,
    "db.rows_read": nonNegativeNumber(result.meta?.rows_read),
    "db.rows_written": nonNegativeNumber(result.meta?.rows_written),
    "db.duration_ms": nonNegativeNumber(
      result.meta?.timings?.sql_duration_ms ?? result.meta?.duration
    ),
    ...(typeof region === "string" ? { "db.served_by_region": region } : {}),
    ...(typeof primary === "boolean" ? { "db.served_by_primary": primary } : {})
  }
}

export const d1FailureTelemetry = (
  queryName: string,
  operation: DatabaseOperation
) => ({
  event: "d1.query.failed",
  "db.system": "cloudflare-d1",
  "db.query.name": queryName,
  "db.operation": operation,
  "error.class": `d1_${operation}_failed`
})

const isD1Telemetry = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  "event" in value &&
  (value.event === "d1.query" || value.event === "d1.query.failed")

const d1StructuredLogger = Logger.make(({ logLevel, message }) => {
  const messages = Array.isArray(message) ? message : [message]
  for (const value of messages) {
    if (!isD1Telemetry(value)) continue
    if (logLevel === "Error" || logLevel === "Fatal") {
      console.error(value)
    } else {
      console.log(value)
    }
  }
})

export const D1StructuredLoggerLive = Logger.layer([d1StructuredLogger], {
  mergeWithExisting: true
})
