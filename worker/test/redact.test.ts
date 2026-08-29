import { describe, expect, it } from "vitest"
import { redactValue } from "../src/redact.js"

describe("redactValue", () => {
  it("redacts default and configured keys recursively", () => {
    expect(redactValue({
      password: "secret",
      nested: {
        apiKey: "visible because normalization is exact",
        "api-key": "hidden",
        customer_reference: "hidden too"
      }
    }, ["customer_reference"])).toEqual({
      password: "[REDACTED]",
      nested: {
        apiKey: "visible because normalization is exact",
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
