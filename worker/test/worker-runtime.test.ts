import { env } from "cloudflare:workers"
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult
} from "cloudflare:test"
import { describe, expect, it } from "vitest"
import worker from "../src/index.js"
import type { PushJobMessage } from "../src/types.js"

const sha256Hex = async (value: string): Promise<string> => {
  const input = Uint8Array.from(new TextEncoder().encode(value))
  const digest = await crypto.subtle.digest("SHA-256", input.buffer)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

const ensureValidationProject = async (): Promise<string> => {
  const apiKey = "ops_proj_validation_contract_test"
  const now = new Date(0).toISOString()
  await env.DB.prepare(
    `INSERT OR IGNORE INTO projects
      (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, 0, 'info', ?, ?)`
  ).bind(
    "prj_validation_contract",
    "Validation contract",
    "validation-contract",
    await sha256Hex(apiKey),
    now,
    now
  ).run()
  return apiKey
}

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

  it("rejects event request bodies above the application limit before authentication", async () => {
    const request = new Request("https://ops.example.com/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Oversized", body: "x".repeat(256 * 1_024) })
    }) as Parameters<typeof worker.fetch>[0]

    const response = await worker.fetch(request, env)
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({
      error: "payload_too_large",
      message: "event request body must not exceed 262144 bytes"
    })
  })

  it("stops reading an unbounded event body once the application limit is crossed", async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(64 * 1_024))
      },
      cancel() {
        cancelled = true
      }
    })
    const request = new Request("https://ops.example.com/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    }) as Parameters<typeof worker.fetch>[0]

    const response = await worker.fetch(request, env)
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
  })

  it("returns the declared 422 validation response from the HTTP boundary", async () => {
    const apiKey = await ensureValidationProject()
    const request = new Request("https://ops.example.com/api/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ title: "x".repeat(241) })
    }) as Parameters<typeof worker.fetch>[0]

    const response = await worker.fetch(request, env)
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: "validation_error",
      message: "event payload failed validation",
      issues: [{ path: ["title"] }]
    })
  })

  it("acknowledges a Queue message whose durable job no longer exists", async () => {
    const batch = createMessageBatch<PushJobMessage>("ops-context-push", [
      {
        id: "missing-job",
        timestamp: new Date(0),
        attempts: 0,
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
