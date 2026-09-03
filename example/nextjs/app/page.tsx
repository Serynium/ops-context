"use client"

export default function Page() {
  return (
    <main>
      <h1>Next.js Sentry test</h1>
      <button
        type="button"
        onClick={() => {
          throw new Error("Next.js client Sentry test")
        }}
      >
        Throw client error
      </button>
    </main>
  )
}
