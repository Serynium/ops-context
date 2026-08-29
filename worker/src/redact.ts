export const DEFAULT_REDACT_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "set-cookie",
  "api_key",
  "apikey",
  "private_key",
  "credit_card",
  "card_number",
  "cvv"
] as const

const normalizeKey = (key: string): string => key.trim().toLowerCase().replaceAll("-", "_")

export const redactValue = (
  input: unknown,
  extraKeys: ReadonlyArray<string> = []
): unknown => {
  const keys = new Set([...DEFAULT_REDACT_KEYS, ...extraKeys].map(normalizeKey))
  const seen = new WeakSet<object>()

  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 12) return "[truncated]"
    if (Array.isArray(value)) return value.slice(0, 100).map((entry) => visit(entry, depth + 1))
    if (typeof value !== "object" || value === null) return value
    if (seen.has(value)) return "[circular]"
    seen.add(value)

    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value).slice(0, 200)) {
      output[key] = keys.has(normalizeKey(key)) ? "[REDACTED]" : visit(child, depth + 1)
    }
    return output
  }

  return visit(input, 0)
}
