import { Effect } from "effect"
import { handleApiSafely } from "./api.js"
import { runMaintenance } from "./maintenance.js"
import { processPushMessage } from "./push.js"
import {
  AppConfig,
  Database,
  PushQueue,
  makeConfig,
  makeDatabase,
  makeQueue
} from "./services.js"
import type { Env, PushJobMessage } from "./types.js"

const runEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  env: Env
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Database, makeDatabase(env.DB)),
      Effect.provideService(AppConfig, makeConfig(env)),
      Effect.provideService(PushQueue, makeQueue(env.PUSH_QUEUE))
    ) as Effect.Effect<A, E>
  )

const withSecurityHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "same-origin")
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

export default {
  async fetch(request, env): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (pathname === "/health" || pathname.startsWith("/api/")) {
      try {
        return withSecurityHeaders(await runEffect(handleApiSafely(request), env))
      } catch (cause) {
        console.error("unhandled API defect", cause)
        return withSecurityHeaders(
          new Response(JSON.stringify({ error: "internal", message: "something went wrong" }), {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" }
          })
        )
      }
    }
    return env.ASSETS.fetch(request)
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const outcome = await runEffect(processPushMessage(message.body), env)
        if (outcome._tag === "Retry") {
          message.retry({ delaySeconds: outcome.delaySeconds })
        } else {
          message.ack()
        }
      } catch (cause) {
        console.error("push consumer defect", cause)
        message.retry({ delaySeconds: 30 })
      }
    }
  },

  scheduled(_controller, env, context): void {
    context.waitUntil(
      runEffect(runMaintenance, env)
        .then((result) => console.log("maintenance completed", result))
        .catch((cause) => console.error("maintenance failed", cause))
    )
  }
} satisfies ExportedHandler<Env, PushJobMessage>
