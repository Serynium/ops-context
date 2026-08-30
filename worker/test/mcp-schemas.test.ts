import { describe, expect, it } from "vitest"
import {
  ListEventsArguments,
  SearchEventsArguments
} from "../src/mcp-schemas.js"

const validate = async (
  schema: typeof ListEventsArguments,
  input: unknown
) => await schema["~standard"].validate(input)

describe("MCP Effect schemas", () => {
  it("validate and type MCP tool arguments through Standard Schema", async () => {
    const result = await validate(ListEventsArguments, {
      project: "production-api",
      level: "error",
      grouped: true,
      limit: 25
    })

    expect(result.issues).toBeUndefined()
    if (result.issues === undefined) {
      expect(result.value).toEqual({
        project: "production-api",
        level: "error",
        grouped: true,
        limit: 25
      })
    }
  })

  it("reject invalid levels and result limits", async () => {
    const invalidLevel = await validate(ListEventsArguments, { level: "fatal" })
    const invalidLimit = await validate(ListEventsArguments, { limit: 101 })

    expect(invalidLevel.issues).toBeDefined()
    expect(invalidLimit.issues).toBeDefined()
  })

  it("reject empty search queries", async () => {
    const result = await SearchEventsArguments["~standard"].validate({ query: "" })
    expect(result.issues).toBeDefined()
  })

  it("rejects overlong and NUL-containing search queries", async () => {
    const overlong = await SearchEventsArguments["~standard"].validate({ query: "a".repeat(241) })
    const nul = await SearchEventsArguments["~standard"].validate({ query: "timeout\0other" })

    expect(overlong.issues).toBeDefined()
    expect(nul.issues).toBeDefined()
  })

  it("generates the MCP JSON Schema from Effect Schema", () => {
    const jsonSchema = ListEventsArguments["~standard"].jsonSchema.input({
      target: "draft-2020-12"
    })
    const properties = jsonSchema.properties as Record<string, unknown>
    const encoded = JSON.stringify(jsonSchema)

    expect(jsonSchema.type).toBe("object")
    expect(Object.keys(properties)).toEqual(expect.arrayContaining([
      "project",
      "level",
      "source",
      "fingerprint",
      "since",
      "until",
      "grouped",
      "silenced",
      "before",
      "limit"
    ]))
    for (const level of ["info", "success", "warning", "error", "critical"]) {
      expect(encoded).toContain(`"${level}"`)
    }
  })
})
