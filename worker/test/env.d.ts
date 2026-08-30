import type { D1Migration } from "cloudflare:test"
import type { Env as AppEnv } from "../src/types.js"

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      readonly TEST_MIGRATIONS: D1Migration[]
    }
  }
}

declare module "cloudflare:workers" {
  interface ProvidedEnv extends AppEnv {
    readonly TEST_MIGRATIONS: D1Migration[]
  }
}

export {}
