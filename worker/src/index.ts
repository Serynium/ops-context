import { Effect, ManagedRuntime } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import {
  attachCloudflareAccess,
  hasVerifiedAppAccess,
  type ExecutionContextWithAccess
} from "./access.js"
import { EVENT_REQUEST_MAX_BYTES } from "./event-contract.js"
import { processIngestDeadLetter, processIngestEvent } from "./events.js"
import { makeLayers } from "./layers.js"
import { McpEndpoint } from "./mcp.js"
import { processDeadLetterMessage, processPushMessage } from "./push.js"
import { decodeQueueCommand, type QueueCommand } from "./queue-contract.js"
import { runRetention } from "./retention.js"
import { isSentryEnvelopePath, SentryEndpoint } from "./sentry.js"
import type { Env } from "./types.js"

const makeRuntime = (env: Env) => {
  const layers = makeLayers(env)
  const programs = ManagedRuntime.make(layers.programs)
  return {
    db: env.DB,
    queue: env.PUSH_QUEUE,
    http: HttpRouter.toWebHandler(layers.http),
    programs
  }
}

type IsolateRuntime = ReturnType<typeof makeRuntime>
let cached: IsolateRuntime | undefined
const STATUS_CACHE_TTL_SECONDS = 15
const EVENT_CACHE_TTL_SECONDS = 5
let eventCacheNamespace: string | undefined
let eventCacheGeneration = 0
const eventReads = new Map<string, Promise<Response>>()
const privateCache = (): Cache =>
  (caches as CacheStorage & { readonly default: Cache }).default

const statusCacheKey = (env: Env): Request =>
  new Request(new URL("/__ops-context-cache/status", env.OPS_BASE_URL || "https://ops-context.invalid"))

const statusResponse = (response: Response, cache: "hit" | "miss"): Response => {
  const result = new Response(response.clone().body, response)
  result.headers.set("cache-control", "no-store")
  result.headers.set("x-ops-status-cache", cache)
  return result
}

const invalidateStatusCache = (env: Env): Promise<boolean> =>
  privateCache().delete(statusCacheKey(env))

const eventCacheKey = (request: Request, env: Env): Request => {
  eventCacheNamespace ??= crypto.randomUUID()
  const source = new URL(request.url)
  const key = new URL("/__ops-context-cache/events", env.OPS_BASE_URL || "https://ops-context.invalid")
  key.search = source.search
  key.searchParams.set("generation", `${eventCacheNamespace}:${eventCacheGeneration}`)
  return new Request(key)
}

const eventResponse = (response: Response, cache: "hit" | "miss" | "coalesced"): Response => {
  const result = new Response(response.clone().body, response)
  result.headers.set("cache-control", "no-store")
  result.headers.set("x-ops-events-cache", cache)
  return result
}

const cachedEventResponse = async (
  request: Request,
  env: Env,
  load: () => Promise<Response>
): Promise<Response> => {
  const key = eventCacheKey(request, env)
  const hit = await privateCache().match(key)
  if (hit) return eventResponse(hit, "hit")

  const pending = eventReads.get(key.url)
  if (pending) return eventResponse(await pending, "coalesced")

  const read = load().then(async (response) => {
    if (response.ok) {
      const stored = response.clone()
      stored.headers.set("cache-control", `max-age=${EVENT_CACHE_TTL_SECONDS}`)
      await privateCache().put(key, stored)
    }
    return response
  })
  eventReads.set(key.url, read)
  try {
    return eventResponse(await read, "miss")
  } finally {
    eventReads.delete(key.url)
  }
}

const invalidateReadCaches = (env: Env): Promise<boolean> => {
  eventCacheGeneration += 1
  return invalidateStatusCache(env)
}

const runtimeFor = (env: Env): IsolateRuntime => {
  if (cached?.db === env.DB && cached.queue === env.PUSH_QUEUE) return cached

  const next = makeRuntime(env)
  cached = next
  return next
}

const jsonErrorResponse = (
  status: number,
  error: string,
  message: string
): Response =>
  new Response(JSON.stringify({ error, message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  })

const internalResponse = (): Response =>
  jsonErrorResponse(500, "internal", "something went wrong")

const eventPayloadLimitResponse = (): Response =>
  jsonErrorResponse(
    413,
    "payload_too_large",
    `event request body must not exceed ${EVENT_REQUEST_MAX_BYTES} bytes`
  )

const cancelRequestBody = async (
  body: ReadableStream<Uint8Array> | null,
  reason: string
): Promise<void> => {
  if (body === null) return
  try {
    await body.cancel(reason)
  } catch {
    // The peer may already have closed or errored the request stream.
  }
}

const eventRequestExceedsLimit = async (
  request: Request,
  pathname: string
): Promise<boolean> => {
  if (request.method !== "POST" || pathname !== "/api/v1/events") return false

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > EVENT_REQUEST_MAX_BYTES) {
      await cancelRequestBody(request.body, "event request body too large")
      return true
    }
  }

  const probe = request.clone()
  const reader = probe.body?.getReader()
  if (reader === undefined) return false

  let receivedBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return false

      receivedBytes += chunk.value.byteLength
      if (receivedBytes <= EVENT_REQUEST_MAX_BYTES) continue

      await Promise.allSettled([
        reader.cancel("event request body too large"),
        cancelRequestBody(request.body, "event request body too large")
      ])
      return true
    }
  } finally {
    reader.releaseLock()
  }
}

interface SafeCommandIdentity {
  readonly command: string
  readonly event_id?: string
  readonly project_id?: string
  readonly subscription_id?: string
}

const safeIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.slice(0, 160)
    : undefined

const safeCommandIdentity = (body: unknown): SafeCommandIdentity => {
  if (typeof body !== "object" || body === null) return { command: "unknown" }
  const record = body as Record<string, unknown>
  const command = record._tag === "IngestEvent" || record._tag === "DeliverPush"
    ? record._tag
    : "unknown"
  const eventId = safeIdentifier(record.eventId)
  const projectId = safeIdentifier(record.projectId)
  const subscriptionId = safeIdentifier(record.subscriptionId)
  return {
    command,
    ...(eventId ? { event_id: eventId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(subscriptionId ? { subscription_id: subscriptionId } : {})
  }
}

const errorClass = (cause: unknown): string =>
  cause instanceof Error && cause.name ? cause.name.slice(0, 120) : "unknown"

export default {
  async fetch(request, env, context): Promise<Response> {
    const authenticatedRequest = await attachCloudflareAccess(
      request,
      env,
      context as ExecutionContextWithAccess
    )

    const pathname = new URL(authenticatedRequest.url).pathname
    if (pathname === "/mcp") {
      try {
        return await runtimeFor(env).programs.runPromise(
          Effect.flatMap(McpEndpoint, (mcp) => mcp.handle(authenticatedRequest))
        )
      } catch (cause) {
        console.error("unhandled MCP defect", cause)
        return internalResponse()
      }
    }
    if (isSentryEnvelopePath(pathname)) {
      try {
        return await runtimeFor(env).programs.runPromise(
          Effect.flatMap(SentryEndpoint, (sentry) => sentry.handle(authenticatedRequest))
        )
      } catch (cause) {
        console.error("unhandled Sentry defect", cause)
        return internalResponse()
      }
    }
    if (pathname === "/health" || pathname.startsWith("/api/")) {
      try {
        const cacheStatus = authenticatedRequest.method === "GET" &&
          pathname === "/api/v1/status" &&
          hasVerifiedAppAccess(authenticatedRequest)
        if (cacheStatus) {
          const hit = await privateCache().match(statusCacheKey(env))
          if (hit) return statusResponse(hit, "hit")
        }
        if (await eventRequestExceedsLimit(authenticatedRequest, pathname)) {
          return eventPayloadLimitResponse()
        }
        const runtime = runtimeFor(env)
        const load = async () => runtime.http.handler(
          authenticatedRequest,
          await runtime.programs.context()
        )
        const cacheEvents = authenticatedRequest.method === "GET" &&
          pathname === "/api/v1/events" &&
          hasVerifiedAppAccess(authenticatedRequest)
        const response = cacheEvents
          ? await cachedEventResponse(authenticatedRequest, env, load)
          : await load()
        if (cacheStatus && response.ok) {
          const stored = new Response(response.clone().body, response)
          stored.headers.set("cache-control", `max-age=${STATUS_CACHE_TTL_SECONDS}`)
          await privateCache().put(statusCacheKey(env), stored)
          return statusResponse(response, "miss")
        }
        if (authenticatedRequest.method !== "GET" && response.ok) {
          await invalidateReadCaches(env)
        }
        return response
      } catch (cause) {
        console.error("unhandled API defect", cause)
        return internalResponse()
      }
    }
    return env.ASSETS.fetch(authenticatedRequest)
  },

  async queue(batch, env): Promise<void> {
    const runtime = runtimeFor(env).programs
    const deadLetterBatch = batch.queue.endsWith("-dlq")

    for (const message of batch.messages) {
      const identity = safeCommandIdentity(message.body)
      try {
        const command = await runtime.runPromise(decodeQueueCommand(message.body))
        if (command._tag === "IngestEvent") {
          if (deadLetterBatch) {
            const outcome = await runtime.runPromise(processIngestDeadLetter(command))
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

          await runtime.runPromise(processIngestEvent(command))
          message.ack()
          continue
        }

        const outcome = await runtime.runPromise(
          deadLetterBatch ? processDeadLetterMessage(command) : processPushMessage(command)
        )
        if (!deadLetterBatch && outcome._tag === "Retry") {
          message.retry({ delaySeconds: outcome.delaySeconds })
        } else {
          if (deadLetterBatch) {
            const telemetry = {
              event: outcome._tag === "PermanentFailure"
                ? "queue.dlq.terminalized"
                : "queue.dlq.reconciled",
              queue: batch.queue,
              command: command._tag,
              event_id: command.eventId,
              subscription_id: command.subscriptionId,
              outcome: outcome._tag
            }
            if (outcome._tag === "PermanentFailure") console.error(telemetry)
            else console.warn(telemetry)
          }
          message.ack()
        }
      } catch (cause) {
        console.error({
          event: deadLetterBatch
            ? "queue.dlq.reconciliation_failed"
            : "queue.consumer.failed",
          queue: batch.queue,
          ...identity,
          "error.class": errorClass(cause)
        })
        message.retry({ delaySeconds: deadLetterBatch ? 60 : 30 })
      }
    }
    await invalidateReadCaches(env)
  },

  scheduled(_controller, env, context): void {
    const runtime = runtimeFor(env).programs
    context.waitUntil(
      runtime.runPromise(runRetention)
        .then((result) => {
          const telemetry = { event: "retention.completed", ...result }
          if (result.continuationRequired) console.warn(telemetry)
          else console.log(telemetry)
          return invalidateReadCaches(env)
        })
        .catch((cause) => console.error("retention failed", cause))
    )
  }
} satisfies ExportedHandler<Env, QueueCommand>
