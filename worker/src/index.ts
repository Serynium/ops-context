import { Effect, ManagedRuntime } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import {
  attachCloudflareAccess,
  type ExecutionContextWithAccess
} from "./access.js"
import { Maintenance, PushDelivery } from "./application.js"
import { EVENT_PAYLOAD_MAX_BYTES } from "./event-contract.js"
import { makeLayers } from "./layers.js"
import { McpEndpoint } from "./mcp.js"
import { isSentryEnvelopePath, SentryEndpoint } from "./sentry.js"
import type { Env, PushJobMessage } from "./types.js"

interface WebHandler {
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}

interface IsolateRuntime {
  readonly db: D1Database
  readonly queue: Queue<PushJobMessage>
  readonly http: WebHandler
  readonly programs: ManagedRuntime.ManagedRuntime<
    PushDelivery | Maintenance | McpEndpoint | SentryEndpoint,
    never
  >
}

let cached: IsolateRuntime | undefined

const runtimeFor = (env: Env): IsolateRuntime => {
  if (cached?.db === env.DB && cached.queue === env.PUSH_QUEUE) return cached

  const layers = makeLayers(env)
  const next: IsolateRuntime = {
    db: env.DB,
    queue: env.PUSH_QUEUE,
    http: HttpRouter.toWebHandler(layers.http),
    programs: ManagedRuntime.make(layers.programs)
  }
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
    `event request body must not exceed ${EVENT_PAYLOAD_MAX_BYTES} bytes`
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
    if (Number.isFinite(declaredBytes) && declaredBytes > EVENT_PAYLOAD_MAX_BYTES) {
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
      if (receivedBytes <= EVENT_PAYLOAD_MAX_BYTES) continue

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

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    request = await attachCloudflareAccess(
      request,
      env,
      (context ?? {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined
      }) as ExecutionContextWithAccess
    ) as typeof request

    const pathname = new URL(request.url).pathname
    if (pathname === "/mcp") {
      try {
        return await runtimeFor(env).programs.runPromise(
          Effect.flatMap(McpEndpoint, (mcp) => mcp.handle(request))
        )
      } catch (cause) {
        console.error("unhandled MCP defect", cause)
        return internalResponse()
      }
    }
    if (isSentryEnvelopePath(pathname)) {
      try {
        return await runtimeFor(env).programs.runPromise(
          Effect.flatMap(SentryEndpoint, (sentry) => sentry.handle(request))
        )
      } catch (cause) {
        console.error("unhandled Sentry defect", cause)
        return internalResponse()
      }
    }
    if (pathname === "/health" || pathname.startsWith("/api/")) {
      try {
        if (await eventRequestExceedsLimit(request, pathname)) {
          return eventPayloadLimitResponse()
        }
        return await runtimeFor(env).http.handler(request)
      } catch (cause) {
        console.error("unhandled API defect", cause)
        return internalResponse()
      }
    }
    return env.ASSETS.fetch(request)
  },

  async queue(batch, env): Promise<void> {
    const runtime = runtimeFor(env).programs
    const deadLetterBatch = batch.queue.endsWith("-dlq")

    for (const message of batch.messages) {
      try {
        const outcome = await runtime.runPromise(
          Effect.flatMap(PushDelivery, (delivery) =>
            deadLetterBatch
              ? delivery.deadLetter(message.body)
              : delivery.process(message.body)
          )
        )
        if (!deadLetterBatch && outcome._tag === "Retry") {
          message.retry({ delaySeconds: outcome.delaySeconds })
        } else {
          message.ack()
        }
      } catch (cause) {
        console.error(deadLetterBatch ? "dead-letter consumer defect" : "push consumer defect", cause)
        message.retry({ delaySeconds: deadLetterBatch ? 60 : 30 })
      }
    }
  },

  scheduled(_controller, env, context): void {
    const runtime = runtimeFor(env).programs
    context.waitUntil(
      runtime.runPromise(Effect.flatMap(Maintenance, (_) => _.run))
        .then((result) => console.log("maintenance completed", result))
        .catch((cause) => console.error("maintenance failed", cause))
    )
  }
} satisfies ExportedHandler<Env, PushJobMessage>
