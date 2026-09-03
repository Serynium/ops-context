import "./styles.css"
import { render } from "preact"
import { RootLayout } from "./app"
import { QueryClient, QueryClientProvider } from "./query"
import { RouterProvider } from "./router"

if (import.meta.env.DEV) {
  void import("react-grab/core").then(({ init }) => init({ telemetry: false }))
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 15_000 },
  },
})

render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider>
      <RootLayout />
    </RouterProvider>
  </QueryClientProvider>,
  document.querySelector<HTMLElement>("#root")!,
)
