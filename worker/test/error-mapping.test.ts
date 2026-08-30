import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { toApiFailure } from "../src/api-models.js"
import type { ApplicationError } from "../src/errors.js"
import { runMcpEffect, toMcpToolFailure } from "../src/mcp.js"

const failures: ReadonlyArray<ApplicationError> = [
  { _tag: "InvalidEvent", message: "invalid event", issues: [{ path: ["title"], message: "required" }] },
  { _tag: "InvalidProject", message: "invalid project" },
  { _tag: "InvalidSubscription", message: "invalid subscription" },
  { _tag: "InvalidSilence", message: "invalid silence" },
  { _tag: "InvalidSettings", message: "invalid settings" },
  { _tag: "InvalidEventQuery", message: "invalid query" },
  { _tag: "ProjectNotFound", message: "project not found" },
  { _tag: "EventNotFound", message: "event not found" },
  { _tag: "SubscriptionNotFound", message: "subscription not found" },
  { _tag: "SilenceNotFound", message: "silence not found" },
  { _tag: "InvalidProjectCredential", message: "invalid project API key" },
  { _tag: "DuplicateExternalId", message: "duplicate external id" },
  { _tag: "ProjectDeletionConflict", message: "last project" },
  { _tag: "PushNotConfigured", message: "Web Push is not configured" },
  { _tag: "RepositoryUnavailable", message: "database query failed" },
  { _tag: "QueueUnavailable", message: "queue failed" },
  { _tag: "CryptographyUnavailable", message: "crypto failed" },
  { _tag: "DeliveryTemporarilyUnavailable", message: "provider failed" }
]

describe("adapter error mappings", () => {
  it("keeps domain and application errors free of HTTP fields", () => {
    for (const failure of failures) {
      expect(failure).not.toHaveProperty("status")
      expect(failure).not.toHaveProperty("code")
    }
  })

  it("maps every application error to stable public JSON error codes", () => {
    const mapped = failures.map(toApiFailure)
    expect(mapped.map((failure) => failure._tag)).toEqual([
      "InvalidError", "InvalidError", "InvalidError", "InvalidError", "InvalidError",
      "InvalidError", "NotFoundError", "NotFoundError", "NotFoundError", "NotFoundError",
      "NotFoundError", "ConflictError", "ConflictError", "ServiceUnavailableError",
      "InternalError", "InternalError", "InternalError", "ServiceUnavailableError"
    ])
    expect(mapped.map((failure) => failure.error)).toEqual([
      "validation_error", "invalid", "invalid", "invalid", "invalid", "invalid",
      "not_found", "not_found", "not_found", "not_found", "not_found", "conflict",
      "conflict", "push_not_configured", "internal", "internal", "internal",
      "service_unavailable"
    ])
  })

  it("maps the same failures to protocol-safe MCP tool errors", () => {
    expect(toMcpToolFailure({
      _tag: "RepositoryUnavailable",
      message: "D1 host and table details"
    })).toEqual({ code: "unavailable", message: "Tool service is temporarily unavailable" })
    expect(failures.map((failure) => toMcpToolFailure(failure).code)).toEqual([
      "invalid_argument", "invalid_argument", "invalid_argument", "invalid_argument",
      "invalid_argument", "invalid_argument", "not_found", "not_found", "not_found",
      "not_found", "not_found", "conflict", "conflict", "unavailable", "unavailable",
      "unavailable", "unavailable", "unavailable"
    ])
  })

  it("maps typed failures before crossing the promise boundary", async () => {
    await expect(runMcpEffect(Effect.fail({
      _tag: "EventNotFound" as const,
      message: "event not found"
    }))).rejects.toThrow("not_found: event not found")

    await expect(runMcpEffect(Effect.fail({
      _tag: "RepositoryUnavailable" as const,
      message: "sensitive D1 details"
    }))).rejects.toThrow("unavailable: Tool service is temporarily unavailable")
  })
})
