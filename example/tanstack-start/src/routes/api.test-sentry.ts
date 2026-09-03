import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/test-sentry")({
  server: {
    handlers: {
      GET: () => {
        throw new Error("TanStack Start server Sentry test")
      }
    }
  }
})
