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

  it("generates the MCP JSON Schema from Effect Schema", () => {
    const jsonSchema = ListEventsArguments["~standard"].jsonSchema.input({
      target: "draft-2020-12"
    })
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>

    expect(jsonSchema.type).toBe("object")
    expect(properties.level?.enum).toEqual(["info", "success", "warning", "error", "critical"])
    expect(properties.limit?.minimum).toBe(1)
    expect(properties.limit?.maximum).toBe(100)
  })
})
