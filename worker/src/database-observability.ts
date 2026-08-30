export type DatabaseOperation = "query" | "write" | "batch"

interface D1Metadata {
  readonly duration?: unknown
  readonly rows_read?: unknown
  readonly rows_written?: unknown
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
) => ({
  event: "d1.query",
  "db.system": "cloudflare-d1",
  "db.query.name": queryName,
  "db.operation": operation,
  "db.rows_returned": result.results?.length ?? 0,
  "db.rows_read": nonNegativeNumber(result.meta?.rows_read),
  "db.rows_written": nonNegativeNumber(result.meta?.rows_written),
  "db.duration_ms": nonNegativeNumber(
    result.meta?.timings?.sql_duration_ms ?? result.meta?.duration
  )
})

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
