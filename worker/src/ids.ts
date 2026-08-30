import { Effect } from "effect"
import { type CryptographyUnavailable } from "./errors.js"
import { CredentialCrypto } from "./services.js"

export const nowIso = (): string => new Date().toISOString()

export const newId = (prefix: string): Effect.Effect<string, CryptographyUnavailable, CredentialCrypto> =>
  Effect.flatMap(CredentialCrypto, (service) => service.newId(prefix))

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))
