import { Effect } from "effect"
import { CredentialCrypto } from "./services.js"
import type { AppError } from "./errors.js"

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
