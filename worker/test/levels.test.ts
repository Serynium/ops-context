import { describe, expect, it } from "vitest"
import { atLeast, isLevel } from "../src/levels.js"

describe("levels", () => {
  it("orders notification levels", () => {
    expect(atLeast("critical", "error")).toBe(true)
    expect(atLeast("success", "warning")).toBe(false)
    expect(atLeast("info", "info")).toBe(true)
  })

  it("validates levels", () => {
    expect(isLevel("warning")).toBe(true)
    expect(isLevel("debug")).toBe(false)
  })
})
