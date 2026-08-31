import { describe, expect, it } from "vitest"
import {
  QUEUE_BILLING_CHUNK_BYTES,
  queueBillingChunks
} from "../src/queue-contract.js"

describe("Queue operation accounting", () => {
  it("uses Cloudflare's 64 KB payload billing chunks", () => {
    expect(queueBillingChunks(0)).toBe(1)
    expect(queueBillingChunks(QUEUE_BILLING_CHUNK_BYTES)).toBe(1)
    expect(queueBillingChunks(QUEUE_BILLING_CHUNK_BYTES + 1)).toBe(2)
    expect(queueBillingChunks(127_900)).toBe(2)
  })
})
