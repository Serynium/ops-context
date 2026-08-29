import { Effect } from "effect"
import { badRequest, type AppError } from "./errors.js"
import { CredentialCrypto, PasswordHasher } from "./services.js"

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

export const base64UrlDecode = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export const sha256Hex = (value: string): Effect.Effect<string, AppError, CredentialCrypto> =>
  Effect.flatMap(CredentialCrypto, (service) => service.sha256Hex(value))

export const randomToken = (bytes = 32): Effect.Effect<string, AppError, CredentialCrypto> =>
  Effect.flatMap(CredentialCrypto, (service) => service.randomToken(bytes))

export const verifyPasswordHash = (
  password: string,
  encoded: string
): Effect.Effect<boolean, AppError, PasswordHasher> =>
  Effect.flatMap(PasswordHasher, (service) => service.verify(password, encoded))

export const parseBasicCredentials = (
  header: string
): Effect.Effect<{ readonly username: string; readonly password: string }, AppError> =>
  Effect.try({
    try: () => {
      const decoded = atob(header.slice("Basic ".length))
      const separator = decoded.indexOf(":")
      if (separator < 0) throw new Error("missing separator")
      return {
        username: decoded.slice(0, separator),
        password: decoded.slice(separator + 1)
      }
    },
    catch: () => badRequest("invalid_authorization", "HTTP Basic credentials are malformed")
  })
