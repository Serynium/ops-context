import { Effect } from "effect"
import { badRequest, internal, type AppError } from "./errors.js"

const encoder = new TextEncoder()

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

export const sha256Hex = (value: string): Effect.Effect<string, AppError> =>
  Effect.tryPromise({
    try: async () => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))),
    catch: (cause) => internal("failed to hash credential", cause)
  })

export const randomToken = (bytes = 32): string => {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return base64UrlEncode(data)
}

const timingSafeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false
  let result = 0
  for (let index = 0; index < left.length; index += 1) {
    result |= left[index]! ^ right[index]!
  }
  return result === 0
}

export const verifyPasswordHash = (
  password: string,
  encoded: string
): Effect.Effect<boolean, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const [algorithm, iterationsText, saltText, expectedText] = encoded.split("$")
      if (algorithm !== "pbkdf2-sha256" || !iterationsText || !saltText || !expectedText) {
        throw new Error("ADMIN_PASSWORD_HASH has an invalid format")
      }

      const iterations = Number.parseInt(iterationsText, 10)
      if (!Number.isInteger(iterations) || iterations < 100_000) {
        throw new Error("ADMIN_PASSWORD_HASH uses an unsafe iteration count")
      }

      const salt = base64UrlDecode(saltText)
      const expected = base64UrlDecode(expectedText)
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        "PBKDF2",
        false,
        ["deriveBits"]
      )
      const derived = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "PBKDF2", hash: "SHA-256", salt, iterations },
          key,
          expected.byteLength * 8
        )
      )
      return timingSafeEqual(derived, expected)
    },
    catch: (cause) => internal("failed to verify administrator password", cause)
  })

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
