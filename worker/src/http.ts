import { Effect } from "effect"
import { appError, badRequest, type AppError } from "./errors.js"

export const jsonResponse = (
  value: unknown,
  status = 200,
  headers?: HeadersInit
): Response => {
  const outputHeaders = new Headers(headers)
  outputHeaders.set("content-type", "application/json; charset=utf-8")
  outputHeaders.set("cache-control", "no-store")
  return new Response(JSON.stringify(value), { status, headers: outputHeaders })
}

export const noContent = (headers?: HeadersInit): Response =>
  new Response(null, headers === undefined ? { status: 204 } : { status: 204, headers })

export const errorResponse = (error: AppError): Response =>
  jsonResponse({ error: error.code, message: error.message }, error.status)

export const readJson = <A>(
  request: Request,
  options: { readonly optional?: boolean; readonly maxBytes?: number } = {}
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const maxBytes = options.maxBytes ?? 1_048_576
      const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10)
      if (contentLength > maxBytes) {
        throw appError(413, "too_large", `request body must be ${maxBytes} bytes or smaller`)
      }

      const text = await request.text()
      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        throw appError(413, "too_large", `request body must be ${maxBytes} bytes or smaller`)
      }
      if (text.trim().length === 0) {
        if (options.optional) return {} as A
        throw badRequest("invalid_json", "request body must be a JSON object")
      }
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw badRequest("invalid_json", "request body must be a JSON object")
      }
      return parsed as A
    },
    catch: (cause) => {
      if (typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === "AppError") {
        return cause as AppError
      }
      return badRequest("invalid_json", "request body is not valid JSON")
    }
  })

export const parseCookies = (request: Request): Readonly<Record<string, string>> => {
  const output: Record<string, string> = {}
  const source = request.headers.get("cookie") ?? ""
  for (const part of source.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key) {
      try {
        output[key] = decodeURIComponent(value)
      } catch {
        output[key] = value
      }
    }
  }
  return output
}

export const serializeCookie = (
  name: string,
  value: string,
  options: {
    readonly maxAge?: number
    readonly expires?: Date
    readonly secure?: boolean
    readonly httpOnly?: boolean
    readonly sameSite?: "Strict" | "Lax" | "None"
    readonly path?: string
  } = {}
): string => {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${options.path ?? "/"}`)
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  if (options.httpOnly !== false) parts.push("HttpOnly")
  if (options.secure) parts.push("Secure")
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`)
  return parts.join("; ")
}

export const getBearer = (request: Request): string | null => {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  const value = header.slice("Bearer ".length).trim()
  return value.length > 0 ? value : null
}

export interface RouteMatch {
  readonly params: Readonly<Record<string, string>>
}

export const matchPath = (pattern: string, pathname: string): RouteMatch | null => {
  const patternParts = pattern.split("/").filter(Boolean)
  const pathParts = pathname.split("/").filter(Boolean)
  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]!
    const actual = pathParts[index]!
    if (expected.startsWith(":")) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual)
      } catch {
        return null
      }
    } else if (expected !== actual) {
      return null
    }
  }
  return { params }
}
