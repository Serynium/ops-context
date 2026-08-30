import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { processPushMessage } from "../src/push.js"
import {
  PushDeliveryRepository,
  type PushContext
} from "../src/push-repository.js"
import { AppConfig, WebPush, type ConfigService } from "../src/services.js"
import { QUEUE_COMMAND_VERSION, type DeliverPushCommand } from "../src/queue-contract.js"

const message: DeliverPushCommand = {
  _tag: "DeliverPush",
  version: QUEUE_COMMAND_VERSION,
  eventId: "evt_test",
  subscriptionId: "sub_test"
}

const config: ConfigService = {
  baseUrl: "https://ops.example.com",
  appOrigin: "https://ops.example.com",
  appHost: "ops.example.com",
  defaultRetentionDays: 0,
  maxPushAttempts: 6,
  vapidPublicKey: "unused",
  vapidPrivateJwk: "unused",
  vapidSubject: "mailto:test@example.com"
}

const claimed = {
  message,
  leaseUntil: "2026-08-31T12:01:00.000Z"
} as const

const context: PushContext = {
  job: {
    event_id: message.eventId,
    subscription_id: message.subscriptionId,
    state: "sending",
    attempts: 1,
    available_at: "2026-08-31T12:00:00.000Z",
    queued_at: "2026-08-31T12:00:00.000Z",
    lease_until: claimed.leaseUntil,
    dead_at: null,
    last_error: "",
    updated_at: "2026-08-31T12:00:00.000Z"
  },
  event: {
    id: message.eventId,
    external_id: null,
    project_id: "prj_test",
    project_name: "Test",
    project_slug: "test",
    project_icon: "",
    source: "test",
    type: "test",
    level: "error",
    title: "Failure",
    body: "Details",
    fingerprint: "fingerprint",
    payload_json: "{}",
    actions_json: "[]",
    occurred_at: "2026-08-31T12:00:00.000Z",
    created_at: "2026-08-31T12:00:00.000Z",
    silence_id: null
  },
  subscription: {
    id: message.subscriptionId,
    name: "Test browser",
    endpoint: "https://push.example.test/subscription",
    p256dh: "p256dh-test-key-with-enough-characters",
    auth: "auth-test-key",
    user_agent: "",
    enabled: 1,
    last_seen_at: null,
    renewal_credential_hash: null,
    renewal_credential_issued_at: null,
    previous_renewal_credential_hash: null,
    previous_renewal_credential_valid_until: null,
    explicitly_enrolled: 0,
    deleted_at: null,
    created_at: "2026-08-31T12:00:00.000Z",
    updated_at: "2026-08-31T12:00:00.000Z"
  }
}

const trackingLayer = (
  response: Response,
  operations: Array<string>
) => Layer.mergeAll(
  Layer.succeed(PushDeliveryRepository)({
    claim: () => Effect.sync(() => {
      operations.push("claim")
      return claimed
    }),
    loadClaimedContext: () => Effect.sync(() => {
      operations.push("loadClaimedContext")
      return context
    }),
    finalizeSuccess: () => Effect.sync(() => {
      operations.push("finalizeSuccess")
    }),
    finalizeRetry: () => Effect.sync(() => {
      operations.push("finalizeRetry")
    }),
    finalizeDead: (_claim, _status, _error, disableSubscription) => Effect.sync(() => {
      operations.push(disableSubscription ? "finalizeDead:disable" : "finalizeDead")
    }),
    finalizeDeadLetter: () => Effect.succeed(false)
  }),
  Layer.succeed(AppConfig)(config),
  Layer.succeed(WebPush)({ send: () => Effect.succeed(response) })
)

describe("push repository operation sequence", () => {
  it("claims, loads once, and atomically finalizes a success", async () => {
    const operations: Array<string> = []
    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(trackingLayer(new Response(null, { status: 201 }), operations))
      )
    )

    expect(outcome._tag).toBe("Delivered")
    expect(operations).toEqual(["claim", "loadClaimedContext", "finalizeSuccess"])
  })

  it("claims, loads once, and atomically schedules a retry", async () => {
    const operations: Array<string> = []
    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(trackingLayer(new Response("retry", { status: 503 }), operations))
      )
    )

    expect(outcome._tag).toBe("Retry")
    expect(operations).toEqual(["claim", "loadClaimedContext", "finalizeRetry"])
  })

  it("claims, loads once, and atomically disables a permanently rejected subscription", async () => {
    const operations: Array<string> = []
    const outcome = await Effect.runPromise(
      processPushMessage(message).pipe(
        Effect.provide(trackingLayer(new Response("gone", { status: 410 }), operations))
      )
    )

    expect(outcome._tag).toBe("PermanentFailure")
    expect(operations).toEqual(["claim", "loadClaimedContext", "finalizeDead:disable"])
  })
})
