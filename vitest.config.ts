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

  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: path.join(root, "wrangler.test.jsonc")
        },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_PASSWORD_HASH: "pbkdf2-sha256$100000$dGVzdC1zYWx0$dGVzdC1oYXNo",
            VAPID_PUBLIC_KEY: "test-vapid-public-key",
            VAPID_PRIVATE_JWK: "{}",
            VAPID_SUBJECT: "mailto:test@example.com",
            OPS_MCP_TOKEN: "test-mcp-token-0000000000000000"
          }
        }
      })
    ],
    test: {
      include: ["worker/test/**/*.test.ts"],
      setupFiles: ["./worker/test/setup.ts"]
    }
  }
})
