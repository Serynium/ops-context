import { env } from "cloudflare:workers"
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  SELF
} from "cloudflare:test"
import { describe, expect, it } from "vitest"
import worker from "../src/index.js"
import {
  QUEUE_COMMAND_VERSION,
  type IngestEventCommand,
  type QueueCommand
} from "../src/queue-contract.js"
import {
  pruneEventsBeforeSql,
  pruneTerminalPushJobsBeforeSql
} from "../src/repositories.js"
import {
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES
} from "../src/retention.js"

const integer = (name: string, value: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return parsed
}

const projectCount = integer("OPS_SCALE_PROJECTS", env.SCALE_PROJECTS)
const eventCount = integer("OPS_SCALE_EVENTS", env.SCALE_EVENTS)
const queryCount = integer("OPS_SCALE_QUERIES", env.SCALE_QUERIES)
const concurrency = integer("OPS_SCALE_CONCURRENCY", env.SCALE_CONCURRENCY)
const ingestEventCount = integer("OPS_SCALE_INGEST_EVENTS", env.SCALE_INGEST_EVENTS)
const subscriptionCount = integer("OPS_SCALE_SUBSCRIPTIONS", env.SCALE_SUBSCRIPTIONS)
const consumerConcurrency = 8
const eventChunkSize = 10_000
const scaleApiKey = "ops_proj_scale_benchmark"

const reset = async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM push_jobs"),
    env.DB.prepare("DELETE FROM event_aliases"),
    env.DB.prepare("DELETE FROM ingestion_failures"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM silences"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM push_subscriptions")
  ])
}

interface SeedMeasurement {
  readonly duration_ms: number
  readonly database_bytes: number
  readonly event_bytes: number
  readonly event_rows_written: number
}

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const seedFixture = async (): Promise<SeedMeasurement> => {
  const started = performance.now()
  await env.DB.prepare(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM sequence WHERE value < ?
     )
     INSERT INTO projects
       (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
     SELECT
       printf('prj_scale_%06d', value),
       printf('Scale project %d', value),
       printf('scale-project-%d', value),
       '', printf('scale-hash-%d', value), 0, 'info',
       '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
     FROM sequence`
  ).bind(projectCount).run()
  const projectCredential = await env.DB.prepare(
    "UPDATE projects SET api_key_hash = ? WHERE id = 'prj_scale_000001'"
  ).bind(await sha256Hex(scaleApiKey)).run()
  const databaseBytesBeforeEvents = projectCredential.meta.size_after
  let databaseBytes = databaseBytesBeforeEvents
  let eventRowsWritten = 0

  for (let offset = 0; offset < eventCount; offset += eventChunkSize) {
    const end = Math.min(offset + eventChunkSize, eventCount)
    const result = await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT ? + 1
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < ?
       )
       INSERT INTO events (
         id, external_id, project_id, source, type, level, title, body, fingerprint,
         payload_json, actions_json, occurred_at, created_at, silence_id,
         fanout_completed_at, fanout_published_at
       )
       SELECT
         printf('evt_scale_%09d', value), NULL,
         printf('prj_scale_%06d', ((value - 1) % ?) + 1),
         printf('source-%02d', value % 10), 'fixture',
         CASE value % 20
           WHEN 0 THEN 'critical'
           WHEN 1 THEN 'error'
           WHEN 2 THEN 'error'
           WHEN 3 THEN 'warning'
           WHEN 4 THEN 'success'
           ELSE 'info'
         END,
         CASE WHEN value % 100 = 0
           THEN printf('Needle timeout event %d', value)
           ELSE printf('Synthetic event %d', value)
         END,
         printf('Synthetic body for event %d', value),
         CASE WHEN (CAST((value - 1) / ? AS INTEGER) % 5) = 0 THEN ''
           ELSE printf(
             'fingerprint_%06d_%06d',
             ((value - 1) % ?) + 1,
             CAST((value - 1) / (? * 20) AS INTEGER)
           )
         END,
         json_object(
           'region', printf('region-%d', value % 4),
           'trace', printf('trace-%d', value)
         ),
         '[]',
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-09-01T00:00:00Z', printf('-%d seconds', value % 7776000)),
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-09-01T00:00:00Z', printf('-%d seconds', value % 7776000)),
         NULL,
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-09-01T00:00:00Z', printf('-%d seconds', value % 7776000)),
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-09-01T00:00:00Z', printf('-%d seconds', value % 7776000))
       FROM sequence`
    ).bind(
      offset,
      end,
      projectCount,
      projectCount,
      projectCount,
      projectCount
    ).run()
    databaseBytes = result.meta.size_after
    eventRowsWritten += result.meta.rows_written
  }

  return {
    duration_ms: performance.now() - started,
    database_bytes: databaseBytes,
    event_bytes: Math.max(0, databaseBytes - databaseBytesBeforeEvents),
    event_rows_written: eventRowsWritten
  }
}

interface Measurement {
  readonly query: string
  readonly requests: number
  readonly concurrency: number
  readonly requests_per_second: number
  readonly p50_ms: number
  readonly p95_ms: number
  readonly p99_ms: number
  readonly average_response_bytes: number
}

interface StorageObject {
  readonly name: string
  readonly rows: number
  readonly logical_bytes: number
}

interface RetentionMeasurement {
  readonly deleted_events: number
  readonly batches: number
  readonly duration_ms: number
  readonly rows_written: number
  readonly database_bytes_after: number
}

interface TerminalCleanupMeasurement {
  readonly deleted_jobs: number
  readonly duration_ms: number
  readonly rows_written: number
  readonly reclaimed_bytes: number
}

interface DeliveryStorageMeasurement {
  readonly deliveries: number
  readonly logical_bytes: number
  readonly database_bytes: number
  readonly rows_written: number
}

interface IngestionMeasurement {
  readonly accepted_events: number
  readonly acceptance_requests_per_second: number
  readonly acceptance_p95_ms: number
  readonly persisted_events_per_second: number
  readonly consumer_concurrency: number
  readonly consumer_p95_lag_ms: number
  readonly push_jobs: number
  readonly potential_push_jobs: number
  readonly retry_delay_seconds: number
  readonly database_bytes_per_event: number
  readonly database_bytes_after: number
}

const storageObjects = async (): Promise<ReadonlyArray<StorageObject>> => {
  // ponytail: D1 does not expose dbstat; replace this logical-byte view if it adds per-object page metrics.
  const result = await env.DB.prepare(
    `SELECT 'events' AS name, COUNT(*) AS rows,
       COALESCE(SUM(
         LENGTH(id) + LENGTH(COALESCE(external_id, '')) + LENGTH(project_id) +
         LENGTH(source) + LENGTH(type) + LENGTH(level) + LENGTH(title) + LENGTH(body) +
         LENGTH(fingerprint) + LENGTH(payload_json) + LENGTH(actions_json) +
         LENGTH(occurred_at) + LENGTH(created_at) + LENGTH(COALESCE(silence_id, '')) +
         LENGTH(COALESCE(fanout_completed_at, '')) + LENGTH(COALESCE(fanout_published_at, ''))
       ), 0) AS logical_bytes
     FROM events
     UNION ALL
     SELECT 'event_search', COUNT(*), COALESCE(SUM(
       LENGTH(title) + LENGTH(body) + LENGTH(source) + LENGTH(fingerprint) + LENGTH(payload)
     ), 0)
     FROM event_search
     UNION ALL
     SELECT 'event_groups', COUNT(*), COALESCE(SUM(
       LENGTH(project_id) + LENGTH(fingerprint) + LENGTH(latest_event_id) + 8 +
       LENGTH(first_seen) + LENGTH(last_seen)
     ), 0)
     FROM event_groups
     UNION ALL
     SELECT 'event_groups_by_level', COUNT(*), COALESCE(SUM(
       LENGTH(level) + LENGTH(project_id) + LENGTH(fingerprint) + LENGTH(latest_event_id) + 8 +
       LENGTH(first_seen) + LENGTH(last_seen)
     ), 0)
     FROM event_groups_by_level
     ORDER BY logical_bytes DESC, name`
  ).all<StorageObject>()
  return result.results
}

const measureDeletes = async (sql: string, cutoff: string) => {
  const started = performance.now()
  let deleted = 0
  let rowsWritten = 0
  let databaseBytesAfter = 0
  let batches = 0
  while (batches < RETENTION_MAX_BATCHES) {
    const [result, countResult] = await env.DB.batch([
      env.DB.prepare(sql).bind(cutoff, RETENTION_BATCH_SIZE),
      env.DB.prepare("SELECT changes() AS count")
    ])
    const batchDeleted = Number(
      (countResult?.results[0] as { readonly count?: unknown } | undefined)?.count ?? 0
    )
    if (!result) throw new Error("delete batch returned no D1 result")
    deleted += batchDeleted
    rowsWritten += result.meta.rows_written
    databaseBytesAfter = result.meta.size_after
    batches += 1
    if (batchDeleted < RETENTION_BATCH_SIZE) break
  }
  return {
    deleted,
    batches,
    duration_ms: performance.now() - started,
    rows_written: rowsWritten,
    database_bytes_after: databaseBytesAfter
  }
}

const measureRetention = async (): Promise<RetentionMeasurement> => {
  const result = await measureDeletes(pruneEventsBeforeSql, "9999-12-31T23:59:59.999Z")
  return { ...result, deleted_events: result.deleted }
}

const measureTerminalCleanup = async (): Promise<TerminalCleanupMeasurement> => {
  const terminalized = await env.DB.prepare(
    "UPDATE push_jobs SET state = 'sent', updated_at = '2020-01-01T00:00:00.000Z'"
  ).run()
  const databaseBytesBefore = terminalized.meta.size_after
  const result = await measureDeletes(pruneTerminalPushJobsBeforeSql, "2026-01-01T00:00:00.000Z")
  return {
    deleted_jobs: result.deleted,
    duration_ms: result.duration_ms,
    rows_written: result.rows_written,
    reclaimed_bytes: Math.max(0, databaseBytesBefore - result.database_bytes_after)
  }
}

const measureDeliveryStorage = async (): Promise<DeliveryStorageMeasurement> => {
  const databaseBytesBefore = (await env.DB.prepare("SELECT 1").all()).meta.size_after
  const inserted = await env.DB.prepare(
    `INSERT INTO deliveries
       (event_id, subscription_id, status, response_status, error, attempted_at, created_at)
     SELECT event_id, subscription_id, 'sent', 201, '',
            '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
     FROM push_jobs`
  ).run()
  const storage = await env.DB.prepare(
    `SELECT COUNT(*) AS deliveries,
       COALESCE(SUM(
         8 + LENGTH(event_id) + LENGTH(subscription_id) + LENGTH(status) +
         8 + LENGTH(error) + LENGTH(attempted_at) + LENGTH(created_at)
       ), 0) AS logical_bytes
     FROM deliveries`
  ).first<{ readonly deliveries: number; readonly logical_bytes: number }>()

  return {
    deliveries: storage?.deliveries ?? 0,
    logical_bytes: storage?.logical_bytes ?? 0,
    database_bytes: Math.max(0, inserted.meta.size_after - databaseBytesBefore),
    rows_written: inserted.meta.rows_written
  }
}

const percentile = (sorted: ReadonlyArray<number>, value: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0

const chunks = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const result: Array<ReadonlyArray<A>> = []
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size))
  }
  return result
}

const measureIngestion = async (): Promise<IngestionMeasurement> => {
  await env.DB.prepare(
    "UPDATE projects SET notify = 1 WHERE id = 'prj_scale_000001'"
  ).run()
  await env.DB.prepare(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM sequence WHERE value < ?
     )
     INSERT INTO push_subscriptions
       (id, name, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at)
     SELECT
       printf('sub_scale_%04d', value), printf('Scale subscription %d', value),
       printf('https://push.example.test/%d', value), 'p256dh-scale', 'auth-scale',
       'scale-benchmark', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
     FROM sequence`
  ).bind(subscriptionCount).run()
  const databaseBytesBefore = (await env.DB.prepare("SELECT 1").all()).meta.size_after

  const published: QueueCommand[] = []
  const capturedQueue = {
    send: async (body: QueueCommand) => { published.push(body) },
    sendBatch: async (messages: Iterable<{ readonly body: QueueCommand }>) => {
      for (const message of messages) published.push(message.body)
    }
  } as unknown as Queue<QueueCommand>
  const consumerEnv = new Proxy(env, {
    get: (target, property) => property === "PUSH_QUEUE"
      ? capturedQueue
      : Reflect.get(target, property)
  })
  const acceptanceTimings: Array<number> = []
  let next = 0
  const acceptanceStarted = performance.now()
  const accept = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= ingestEventCount) return
      const event = {
        external_id: `scale-ingest-${index}`,
        title: `Scale HTTP ingest ${index}`,
        body: "Accepted through HTTP and persisted through the Queue consumer",
        level: "error" as const,
        source: "scale-http",
        fingerprint: `scale-http-${index % 10}`,
        data: { trace: `scale-http-trace-${index}` }
      }
      const started = performance.now()
      const request = new Request("http://localhost/api/v1/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${scaleApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(event)
      }) as Parameters<typeof worker.fetch>[0]
      const response = await worker.fetch(request, consumerEnv, createExecutionContext())
      if (response.status !== 202) {
        throw new Error(`ingestion acceptance returned ${response.status}: ${await response.text()}`)
      }
      await response.arrayBuffer()
      acceptanceTimings.push(performance.now() - started)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ingestEventCount) }, accept))
  const acceptanceDuration = performance.now() - acceptanceStarted
  acceptanceTimings.sort((left, right) => left - right)

  const commands = published.splice(0).filter(
    (command): command is IngestEventCommand => command._tag === "IngestEvent"
  )
  expect(commands).toHaveLength(ingestEventCount)
  const batches = chunks(commands, 10)
  const consumerStarted = performance.now()
  for (const group of chunks(batches, consumerConcurrency)) {
    await Promise.all(group.map(async (messages, batchIndex) => {
      const batch = createMessageBatch<QueueCommand>("ops-context-push", messages.map((body, index) => ({
        id: `scale-ingest-${batchIndex}-${index}-${body.eventId}`,
        timestamp: new Date(body.acceptedAt),
        attempts: 0,
        body
      })))
      await worker.queue(batch, consumerEnv)
    }))
  }
  const consumerDuration = performance.now() - consumerStarted
  const lagTimings = commands
    .map((command) => Date.now() - new Date(command.acceptedAt).getTime())
    .sort((left, right) => left - right)
  const persisted = (await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE source = 'scale-http'"
  ).first<{ count: number }>())?.count ?? 0
  const pushJobs = (await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM push_jobs"
  ).first<{ count: number }>())?.count ?? 0
  expect(persisted).toBe(ingestEventCount)
  const potentialPushJobs = ingestEventCount * subscriptionCount
  expect(pushJobs).toBe(Math.min(ingestEventCount, 10) * subscriptionCount)
  expect(published).toHaveLength(pushJobs)

  const deferred = await env.DB.prepare(
    "SELECT event_id, subscription_id FROM push_jobs ORDER BY event_id, subscription_id LIMIT 1"
  ).first<{ event_id: string; subscription_id: string }>()
  if (!deferred) throw new Error("ingestion fan-out created no push job")
  const deferredAvailableAt = new Date(Date.now() + 60_000).toISOString()
  await env.DB.prepare(
    "UPDATE push_jobs SET state = 'retrying', available_at = ? WHERE event_id = ? AND subscription_id = ?"
  ).bind(
    deferredAvailableAt,
    deferred.event_id,
    deferred.subscription_id
  ).run()
  const retryBatch = createMessageBatch<QueueCommand>("ops-context-push", [{
    id: "scale-deferred-retry",
    timestamp: new Date(),
    attempts: 1,
    body: {
      _tag: "DeliverPush",
      version: QUEUE_COMMAND_VERSION,
      eventId: deferred.event_id,
      subscriptionId: deferred.subscription_id
    }
  }])
  const retryContext = createExecutionContext()
  await worker.queue(retryBatch, consumerEnv)
  const retryResult = await getQueueResult(retryBatch, retryContext)
  const retryDelaySeconds = Math.max(
    1,
    Math.ceil((new Date(deferredAvailableAt).getTime() - Date.now()) / 1000)
  )
  expect(retryResult.retryMessages).toHaveLength(1)

  const databaseBytesAfter = (await env.DB.prepare("SELECT 1").all()).meta.size_after
  return {
    accepted_events: ingestEventCount,
    acceptance_requests_per_second: ingestEventCount / (acceptanceDuration / 1000),
    acceptance_p95_ms: percentile(acceptanceTimings, 0.95),
    persisted_events_per_second: ingestEventCount / (consumerDuration / 1000),
    consumer_concurrency: consumerConcurrency,
    consumer_p95_lag_ms: percentile(lagTimings, 0.95),
    push_jobs: pushJobs,
    potential_push_jobs: potentialPushJobs,
    retry_delay_seconds: retryDelaySeconds,
    database_bytes_per_event: (databaseBytesAfter - databaseBytesBefore) / ingestEventCount,
    database_bytes_after: databaseBytesAfter
  }
}

const request = async (path: string): Promise<Response> => {
  const response = await SELF.fetch(`http://localhost${path}`)
  if (response.status !== 200) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`)
  }
  return response
}

const measure = async (query: string, path: string): Promise<Measurement> => {
  await (await request(path)).arrayBuffer()
  let next = 0
  let bytes = 0
  const timings: Array<number> = []
  const started = performance.now()

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= queryCount) return
      const requestStarted = performance.now()
      const body = await (await request(path)).arrayBuffer()
      timings.push(performance.now() - requestStarted)
      bytes += body.byteLength
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queryCount) }, worker)
  )
  const elapsed = performance.now() - started
  timings.sort((left, right) => left - right)

  return {
    query,
    requests: queryCount,
    concurrency: Math.min(concurrency, queryCount),
    requests_per_second: +(queryCount / (elapsed / 1000)).toFixed(1),
    p50_ms: +percentile(timings, 0.5).toFixed(1),
    p95_ms: +percentile(timings, 0.95).toFixed(1),
    p99_ms: +percentile(timings, 0.99).toFixed(1),
    average_response_bytes: Math.round(bytes / queryCount)
  }
}

describe("opt-in scale benchmark", () => {
  it(`measures ${projectCount} projects and ${eventCount} events`, async ({ annotate }) => {
    await reset()
    const seed = await seedFixture()

    const projects = await (await request("/api/v1/projects")).json<{
      projects: ReadonlyArray<unknown>
      next_cursor?: string
    }>()
    const status = await (await request("/api/v1/status")).json<{
      projects: number
      events: number
    }>()
    expect(projects.projects).toHaveLength(Math.min(100, projectCount))
    expect(Boolean(projects.next_cursor)).toBe(projectCount > 100)
    expect(status).toMatchObject({ projects: projectCount, events: eventCount })

    const firstPage = await (await request("/api/v1/events?limit=50")).json<{
      events: ReadonlyArray<unknown>
      next_cursor?: string
    }>()
    expect(firstPage.events).toHaveLength(Math.min(50, eventCount))

    const indexed = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM event_search"
    ).first<{ count: number }>()
    expect(indexed?.count).toBe(eventCount)
    expect(seed.event_bytes).toBeGreaterThan(0)
    expect(seed.event_rows_written).toBeGreaterThanOrEqual(eventCount)

    const paths: ReadonlyArray<readonly [string, string]> = [
      ["projects", "/api/v1/projects?limit=100"],
      ["status", "/api/v1/status"],
      ["events", "/api/v1/events?limit=50"],
      ["events_grouped", "/api/v1/events?grouped=true&limit=50"],
      ["events_project_grouped", "/api/v1/events?project=prj_scale_000001&grouped=true&limit=50"],
      ["events_filtered_grouped", "/api/v1/events?level=error&grouped=true&limit=50"],
      ["events_search_common", "/api/v1/events?search=needle&since=2026-08-25T00:00:00Z&limit=50"],
      ["events_search_prefix", "/api/v1/events?search=need*&since=2026-08-25T00:00:00Z&limit=50"],
      ["events_search_selective", "/api/v1/events?search=%22trace-100%22&since=2026-08-25T00:00:00Z&limit=50"],
      ...(firstPage.next_cursor
        ? [["events_cursor", `/api/v1/events?before=${encodeURIComponent(firstPage.next_cursor)}&limit=50`] as const]
        : [])
    ]
    const results: Array<Measurement> = []
    for (const [name, path] of paths) results.push(await measure(name, path))

    const groupCount = (await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM event_groups"
    ).first<{ count: number }>())?.count ?? 0
    const storageBeforeRetention = await storageObjects()
    const logicalBytesBeforeRetention = storageBeforeRetention.reduce(
      (total, object) => total + object.logical_bytes,
      0
    )
    const bytesPerEvent = seed.event_bytes / eventCount
    const rowsWrittenPerEvent = seed.event_rows_written / eventCount
    await annotate(
      `fixture: ${projectCount} projects, ${eventCount} events, ${groupCount} groups, ${seed.duration_ms.toFixed(1)}ms seed`,
      "benchmark"
    )
    await annotate(
      `storage: ${(seed.database_bytes / 1_048_576).toFixed(1)} MiB total, ${bytesPerEvent.toFixed(1)} bytes/event, ${rowsWrittenPerEvent.toFixed(1)} D1 rows_written/event`,
      "benchmark"
    )
    await annotate(
      `fixture capacity: ~${Math.floor(500_000_000 / bytesPerEvent).toLocaleString("en-US")} events at 500 MB, ~${Math.floor(10_000_000_000 / bytesPerEvent).toLocaleString("en-US")} at 10 GB`,
      "benchmark"
    )
    await annotate(
      `event storage content: ${storageBeforeRetention.map((object) => `${object.name} ${object.rows.toLocaleString("en-US")} rows/${(object.logical_bytes / 1_048_576).toFixed(1)} MiB logical`).join(", ")}; ${((seed.database_bytes - logicalBytesBeforeRetention) / 1_048_576).toFixed(1)} MiB indexes/pages/other tables`,
      "benchmark"
    )
    for (const result of results) {
      await annotate(
        `${result.query}: ${result.requests_per_second} req/s, p50 ${result.p50_ms}ms, p95 ${result.p95_ms}ms, p99 ${result.p99_ms}ms, ${result.average_response_bytes} bytes`,
        "benchmark"
      )
    }

    const ingestion = await measureIngestion()
    await annotate(
      `ingestion acceptance: ${ingestion.accepted_events} events, ${ingestion.acceptance_requests_per_second.toFixed(1)} req/s, p95 ${ingestion.acceptance_p95_ms.toFixed(1)}ms`,
      "benchmark"
    )
    await annotate(
      `ingestion consumer: ${ingestion.persisted_events_per_second.toFixed(1)} events/s at ${ingestion.consumer_concurrency} consumers, p95 queue lag ${ingestion.consumer_p95_lag_ms.toFixed(1)}ms, ${ingestion.push_jobs.toLocaleString("en-US")}/${ingestion.potential_push_jobs.toLocaleString("en-US")} push jobs after fingerprint collapse, ${ingestion.database_bytes_per_event.toFixed(1)} bytes/event with fan-out, deferred retry ${ingestion.retry_delay_seconds}s`,
      "benchmark"
    )
    const deliveryStorage = await measureDeliveryStorage()
    expect(deliveryStorage.deliveries).toBe(ingestion.push_jobs)
    await annotate(
      `delivery storage: ${deliveryStorage.deliveries.toLocaleString("en-US")} rows, ${(deliveryStorage.logical_bytes / deliveryStorage.deliveries).toFixed(1)} logical bytes/delivery, ${(deliveryStorage.database_bytes / deliveryStorage.deliveries).toFixed(1)} database bytes/delivery, ${(deliveryStorage.rows_written / deliveryStorage.deliveries).toFixed(1)} D1 rows_written/delivery`,
      "benchmark"
    )
    const terminalCleanup = await measureTerminalCleanup()
    expect(terminalCleanup.deleted_jobs).toBe(ingestion.push_jobs)
    await annotate(
      `terminal job cleanup: ${terminalCleanup.deleted_jobs.toLocaleString("en-US")} jobs in ${terminalCleanup.duration_ms.toFixed(1)}ms, ${(terminalCleanup.rows_written / terminalCleanup.deleted_jobs).toFixed(1)} D1 rows_written/job, ${terminalCleanup.reclaimed_bytes.toLocaleString("en-US")} database bytes reclaimed`,
      "benchmark"
    )
    const totalEventCount = eventCount + ingestEventCount
    const retentionStorageBefore = await storageObjects()
    const logicalBytesBeforePrune = retentionStorageBefore.reduce(
      (total, object) => total + object.logical_bytes,
      0
    )
    const retention = await measureRetention()
    const remainingEvents = (await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM events"
    ).first<{ count: number }>())?.count ?? 0
    const logicalBytesAfterRetention = (await storageObjects()).reduce(
      (total, object) => total + object.logical_bytes,
      0
    )
    expect(retention.deleted_events).toBe(Math.min(
      totalEventCount,
      RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES
    ))
    expect(remainingEvents).toBe(totalEventCount - retention.deleted_events)
    await annotate(
      `retention: ${retention.deleted_events.toLocaleString("en-US")} events in ${retention.batches} batches, ${remainingEvents.toLocaleString("en-US")} remaining, ${retention.duration_ms.toFixed(1)}ms, ${(retention.deleted_events / (retention.duration_ms / 1000)).toFixed(1)} events/s, ${(retention.rows_written / retention.deleted_events).toFixed(1)} D1 rows_written/event`,
      "benchmark"
    )
    await annotate(
      `retention storage: ${Math.max(0, logicalBytesBeforePrune - logicalBytesAfterRetention).toLocaleString("en-US")} logical content bytes removed, ${Math.max(0, ingestion.database_bytes_after - retention.database_bytes_after).toLocaleString("en-US")} database bytes reclaimed`,
      "benchmark"
    )
  })
})
