import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { decodeCreateEventInput } from "../src/event-contract.js"

const expectInvalidActions = async (actions: unknown): Promise<void> => {
  await expect(
    Effect.runPromise(decodeCreateEventInput({ title: "Action test", actions }))
  ).rejects.toMatchObject({
    _tag: "InvalidEvent"
  })
}

describe("event actions", () => {
  it("normalizes valid HTTP(S) action URLs", async () => {
    const input = await Effect.runPromise(decodeCreateEventInput({
      title: "Action test",
      actions: [{ label: " Open run ", url: "https://example.com/runs/42" }]
    }))

    expect(input.actions).toEqual([
      { label: "Open run", url: "https://example.com/runs/42" }
    ])
  })

  it("limits actions to three", async () => {
    await expectInvalidActions([
      { label: "One", url: "https://example.com/1" },
      { label: "Two", url: "https://example.com/2" },
      { label: "Three", url: "https://example.com/3" },
      { label: "Four", url: "https://example.com/4" }
    ])
  })

  it("accepts only HTTP and HTTPS URLs", async () => {
    await expectInvalidActions([{ label: "Run", url: "javascript:alert(1)" }])
    await expectInvalidActions([{ label: "Data", url: "data:text/html,hello" }])
    await expectInvalidActions([{ label: "File", url: "file:///etc/passwd" }])
    await expectInvalidActions([{ label: "FTP", url: "ftp://example.com/file" }])
  })

  it("requires short non-empty labels", async () => {
    await expectInvalidActions([{ label: "", url: "https://example.com" }])
    await expectInvalidActions([{ label: "x".repeat(41), url: "https://example.com" }])
  })
})
