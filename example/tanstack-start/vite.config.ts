import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  server: { port: 3001 },
  plugins: [
    tanstackStart(),
    react(),
    sentryTanstackStart({
      silent: true,
      telemetry: false,
      sourcemaps: { disable: true }
    })
  ]
})
