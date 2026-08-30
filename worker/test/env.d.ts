import type { Env } from "../src/types.js"

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    readonly TEST_MIGRATIONS: ReadonlyArray<D1Migration>
  }
}
