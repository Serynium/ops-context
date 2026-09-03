import * as Sentry from "@sentry/tanstackstart-react"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({ component: Page })

function Page() {
  return (
    <main>
      <h1>TanStack Start Sentry test</h1>
      <button
        type="button"
        onClick={async () => {
          await Sentry.startSpan(
            { name: "Example Frontend Span", op: "test" },
            async () => {
              const response = await fetch("/api/test-sentry")
              if (!response.ok) throw new Error("TanStack Start client Sentry test")
            }
          )
        }}
      >
        Break the world
      </button>
    </main>
  )
}
