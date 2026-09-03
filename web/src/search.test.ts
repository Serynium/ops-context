import { describe, expect, it } from "vitest"
import { inboxSearch } from "./search"

describe("inboxSearch", () => {
  it("keeps valid filters and drops invalid values", () => {
    expect(
      inboxSearch({
        project: "api",
        level: "error",
        silenced: "false",
        grouped: false,
      }),
    ).toEqual({
      project: "api",
      level: "error",
      silenced: "false",
      grouped: false,
    })
    expect(inboxSearch({ grouped: "false" })).toEqual({ grouped: false })
    expect(inboxSearch({ level: "debug", silenced: "maybe", grouped: "invalid" })).toEqual({})
  })
})
