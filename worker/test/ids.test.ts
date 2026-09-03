import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { CredentialCrypto } from "../src/services.js"

describe("generated IDs", () => {
  it("encodes 128 random bits compactly", async () => {
    const id = await Effect.runPromise(
      Effect.flatMap(CredentialCrypto, (_) => _.newId("evt")).pipe(
        Effect.provide(CredentialCrypto.layer)
      )
    )

    expect(id).toMatch(/^evt_[A-Za-z0-9_-]{22}$/u)
  })
})
