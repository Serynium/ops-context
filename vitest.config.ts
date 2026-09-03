import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  cloudflareTest,
  readD1Migrations
} from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"))
  const scale = process.env.OPS_SCALE_TEST === "1"

  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: path.join(root, "wrangler.test.jsonc")
        },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SCALE_PROJECTS: process.env.OPS_SCALE_PROJECTS ?? "100",
            SCALE_EVENTS: process.env.OPS_SCALE_EVENTS ?? "10000",
            SCALE_QUERIES: process.env.OPS_SCALE_QUERIES ?? "20",
            SCALE_CONCURRENCY: process.env.OPS_SCALE_CONCURRENCY ?? "10",
            SCALE_INGEST_EVENTS: process.env.OPS_SCALE_INGEST_EVENTS ?? "100",
            SCALE_SUBSCRIPTIONS: process.env.OPS_SCALE_SUBSCRIPTIONS ?? "10",
            OPS_LOCAL_ACCESS_BYPASS: scale ? "1" : "0",
            VAPID_PUBLIC_KEY: "test-vapid-public-key",
            VAPID_PRIVATE_JWK: "{}",
            VAPID_SUBJECT: "mailto:test@example.com"
          }
        }
      })
    ],
    test: {
      include: [scale
        ? "worker/test/scale.bench.ts"
        : "worker/test/**/*.integration.test.ts"],
      setupFiles: ["./worker/test/setup.ts"],
      testTimeout: scale ? 0 : 5_000,
      hookTimeout: scale ? 0 : 10_000
    }
  }
})
