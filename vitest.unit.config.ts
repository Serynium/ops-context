import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["worker/test/**/*.test.ts"],
    exclude: ["worker/test/**/*.integration.test.ts"]
  }
})
