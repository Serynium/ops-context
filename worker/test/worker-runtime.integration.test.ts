import { env } from "cloudflare:workers"
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult
} from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { ExecutionContextWithAccess } from "../src/access.js"
import worker from "../src/index.js"
import type { PushJobMessage } from "../src/types.js"

const executionContext = (): ExecutionContext => createExecutionContext()

const accessContext = (): ExecutionContextWithAccess => ({
  access: {
    aud: "test-app-audience",
    getIdentity: () => Promise.resolve({
      id: "operator-test",
      email: "operator@example.com",
      name: "Test operator"
    })
  },
  waitUntil: () => undefined,
  passThroughOnException: () => undefined
}) as unknown as ExecutionContextWithAccess

const fetchWorker = (
  request: Request,
  context: ExecutionContext = executionContext()
): Promise<Response> => worker.fetch(
  request as Parameters<typeof worker.fetch>[0],
  env,
  context
)

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

    const names = tables.results.map((row: { readonly name: string }) => row.name)
    expect(names).toEqual(
      expect.arrayContaining([
        "deliveries",
        "events",
        "projects",
        "push_jobs",
        "push_subscriptions",
        "settings",
        "silences"
      ])
    )
    expect(names).not.toContain("admin_sessions")

    const request = new Request(
      "https://ops.example.com/health"
    ) as Parameters<typeof worker.fetch>[0]
    const response = await fetchWorker(request)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })

  it("rejects private API requests without Cloudflare Access", async () => {
    const request = new Request(
      "https://ops.example.com/api/v1/status",
      { headers: { authorization: "Bearer ops_proj_not_admin" } }
    ) as Parameters<typeof worker.fetch>[0]

    const response = await fetchWorker(request)
    expect([401, 403]).toContain(response.status)
  })

  it("rejects event request bodies above the application limit before authentication", async () => {
    const request = new Request("https://ops.example.com/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Oversized", body: "x".repeat(256 * 1_024) })
    }) as Parameters<typeof worker.fetch>[0]

    const response = await fetchWorker(request)
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

    const response = await fetchWorker(request)
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

    const response = await fetchWorker(request)
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

  it("acknowledges a duplicate Queue message after its job is sent", async () => {
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO projects
         (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
         VALUES ('prj_queue_sent', 'Queue sent', 'queue-sent', '', 'hash-sent', 1, 'info', ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO push_subscriptions
         (id, name, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at)
         VALUES ('sub_queue_sent', 'Queue sent', 'https://push.example.test/sent',
                 'p256dh-test-key-with-enough-characters', 'auth-test-key', '', 1, ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO events
         (id, external_id, project_id, source, type, level, title, body, fingerprint,
          payload_json, actions_json, occurred_at, created_at, silence_id)
         VALUES ('evt_queue_sent', NULL, 'prj_queue_sent', 'test', 'test', 'error',
                 'Already sent', '', '', '{}', '[]', ?, ?, NULL)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO push_jobs
         (event_id, subscription_id, state, attempts, available_at, queued_at,
          lease_until, dead_at, last_error, updated_at)
         VALUES ('evt_queue_sent', 'sub_queue_sent', 'sent', 1, ?, ?, NULL, NULL, '', ?)`
      ).bind(now, now, now)
    ])
    const batch = createMessageBatch<PushJobMessage>("ops-context-push", [{
      id: "duplicate-sent-job",
      timestamp: new Date(0),
      attempts: 1,
      body: { eventId: "evt_queue_sent", subscriptionId: "sub_queue_sent" }
    }])
    const context = createExecutionContext()

    await worker.queue(batch, env)

    const result = await getQueueResult(batch, context)
    expect(result, JSON.stringify(result)).toMatchObject({
      explicitAcks: ["duplicate-sent-job"],
      retryMessages: []
    })
  })

  it("requests Queue redelivery when a durable job is not yet available", async () => {
    const now = new Date().toISOString()
    const availableAt = new Date(Date.now() + 60_000).toISOString()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO projects
         (id, name, slug, icon, api_key_hash, notify, min_level, created_at, updated_at)
         VALUES ('prj_queue_retry', 'Queue retry', 'queue-retry', '', 'hash-retry', 1, 'info', ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO push_subscriptions
         (id, name, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at)
         VALUES ('sub_queue_retry', 'Queue retry', 'https://push.example.test/retry',
                 'p256dh-test-key-with-enough-characters', 'auth-test-key', '', 1, ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO events
         (id, external_id, project_id, source, type, level, title, body, fingerprint,
          payload_json, actions_json, occurred_at, created_at, silence_id)
         VALUES ('evt_queue_retry', NULL, 'prj_queue_retry', 'test', 'test', 'error',
                 'Retry later', '', '', '{}', '[]', ?, ?, NULL)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO push_jobs
         (event_id, subscription_id, state, attempts, available_at, queued_at,
          lease_until, dead_at, last_error, updated_at)
         VALUES ('evt_queue_retry', 'sub_queue_retry', 'retrying', 1, ?, ?, NULL, NULL, 'retry', ?)`
      ).bind(availableAt, now, now)
    ])
    const batch = createMessageBatch<PushJobMessage>("ops-context-push", [{
      id: "deferred-job",
      timestamp: new Date(0),
      attempts: 1,
      body: { eventId: "evt_queue_retry", subscriptionId: "sub_queue_retry" }
    }])
    const context = createExecutionContext()

    await worker.queue(batch, env)

    const result = await getQueueResult(batch, context)
    expect(result, JSON.stringify(result)).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: "deferred-job" }]
    })
  })

  it("runs Cloudflare Access authentication and same-origin middleware in Workerd", async () => {
    const authenticated = await fetchWorker(
      new Request("https://ops.example.com/api/v1/status", {
        headers: {
          "x-forwarded-host": "ops.example.com",
          "x-forwarded-proto": "https"
        }
      }),
      accessContext()
    )
    expect(authenticated.status).toBe(200)

    const crossOrigin = await fetchWorker(
      new Request("https://ops.example.com/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-host": "ops.example.com",
          "x-forwarded-proto": "https",
          origin: "https://attacker.example"
        },
        body: JSON.stringify({ name: "Cross-origin project" })
      }),
      accessContext()
    )
    expect(crossOrigin.status).toBe(403)

    const sameOrigin = await fetchWorker(
      new Request("https://ops.example.com/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-host": "ops.example.com",
          "x-forwarded-proto": "https",
          origin: "https://ops.example.com"
        },
        body: JSON.stringify({ name: "Same-origin project" })
      }),
      accessContext()
    )
    expect(sameOrigin.status).toBe(201)
  })
})
