import { describe, expect, it } from "vitest"
import { redactValue } from "../src/redact.js"

describe("redactValue", () => {
  it("redacts normalized default and configured keys recursively", () => {
    expect(redactValue({
      password: "secret",
      nested: {
        apiKey: "hidden after key normalization",
        "api-key": "hidden",
        customer_reference: "hidden too"
      }
    }, ["customer_reference"])).toEqual({
      password: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
        "api-key": "[REDACTED]",
        customer_reference: "[REDACTED]"
      }
    })
  })

  it("handles circular input", () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(redactValue(value)).toEqual({ self: "[circular]" })
  })
})