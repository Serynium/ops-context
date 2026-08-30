import { env } from "cloudflare:workers"
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult
} from "cloudflare:test"
import { describe, expect, it } from "vitest"
import worker from "../src/index.js"
import type { PushJobMessage } from "../src/types.js"

describe("Cloudflare Worker runtime", () => {
  it("applies the real D1 migrations and serves health", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all<{ readonly name: string }>()

    expect(tables.results.map((row: { readonly name: string }) => row.name)).toEqual(
      expect.arrayContaining([
        "admin_sessions",
        "deliveries",
        "events",
        "projects",
        "push_jobs",
        "push_subscriptions",
        "settings",
        "silences"
      ])
    )

    const request = new Request(
      "https://ops.example.com/health"
    ) as Parameters<typeof worker.fetch>[0]
    const response = await worker.fetch(request, env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })

  it("acknowledges a Queue message whose durable job no longer exists", async () => {
    const batch = createMessageBatch<PushJobMessage>("ops-context-push", [
      {
        id: "missing-job",
        timestamp: new Date(0),
        body: {
          eventId: "evt_missing",
          subscriptionId: "sub_missing"
        }
      }
    ])
    const context = createExecutionContext()

    await worker.queue(batch, env)

    const result = await getQueueResult(batch, context)
    expect(result.explicitAcks).toEqual(["missing-job"])
    expect(result.retryMessages).toEqual([])
  })
})
