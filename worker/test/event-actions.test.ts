import { describe, expect, it } from "vitest"
import { normalizeEventActions } from "../src/events.js"

const expectInvalid = (value: unknown): void => {
  try {
    normalizeEventActions(value)
    throw new Error("expected action validation to fail")
  } catch (error) {
    expect(error).toMatchObject({ _tag: "AppError", status: 422 })
  }
}

describe("event actions", () => {
  it("normalizes valid absolute action URLs", () => {
    expect(normalizeEventActions([
      { label: " Open run ", url: "https://example.com/runs/42" }
    ])).toEqual([
      { label: "Open run", url: "https://example.com/runs/42" }
    ])
  })

  it("limits actions to three", () => {
    expectInvalid([
      { label: "One", url: "https://example.com/1" },
      { label: "Two", url: "https://example.com/2" },
      { label: "Three", url: "https://example.com/3" },
      { label: "Four", url: "https://example.com/4" }
    ])
  })

  it("refuses script and data URLs", () => {
    expectInvalid([{ label: "Run", url: "javascript:alert(1)" }])
    expectInvalid([{ label: "Data", url: "data:text/html,hello" }])
    expectInvalid([{ label: "File", url: "file:///etc/passwd" }])
  })

  it("requires short non-empty labels", () => {
    expectInvalid([{ label: "", url: "https://example.com" }])
    expectInvalid([{ label: "x".repeat(41), url: "https://example.com" }])
  })
})
