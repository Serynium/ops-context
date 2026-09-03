import type { D1Migration } from "cloudflare:test"
import type { Env as AppEnv } from "../src/types.js"

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      readonly TEST_MIGRATIONS: D1Migration[]
      readonly SCALE_PROJECTS: string
      readonly SCALE_EVENTS: string
      readonly SCALE_QUERIES: string
      readonly SCALE_CONCURRENCY: string
      readonly SCALE_INGEST_EVENTS: string
      readonly SCALE_SUBSCRIPTIONS: string
    }
  }
}

declare module "cloudflare:workers" {
  interface ProvidedEnv extends AppEnv {
    readonly TEST_MIGRATIONS: D1Migration[]
    readonly SCALE_PROJECTS: string
    readonly SCALE_EVENTS: string
    readonly SCALE_QUERIES: string
    readonly SCALE_CONCURRENCY: string
    readonly SCALE_INGEST_EVENTS: string
    readonly SCALE_SUBSCRIPTIONS: string
  }
}

export {}
