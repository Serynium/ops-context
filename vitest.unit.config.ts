import { defineConfig } from "vitest/config"

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: {
    environment: "node",
    include: ["worker/test/**/*.test.ts", "web/src/**/*.test.ts"],
    exclude: ["worker/test/**/*.integration.test.ts"]
  }
})
