export interface ValidationIssue {
  readonly path: ReadonlyArray<string | number>
  readonly message: string
}

export interface AppError {
  readonly _tag: "AppError"
  readonly status: number
  readonly code: string
  readonly message: string
  readonly cause?: unknown
}

export const appError = (
  status: number,
  code: string,
  message: string,
  cause?: unknown
): AppError => ({ _tag: "AppError", status, code, message, cause })

export const badRequest = (code: string, message: string): AppError =>
  appError(400, code, message)

export const unauthorized = (message = "authentication required"): AppError =>
  appError(401, "unauthorized", message)

export const forbidden = (message = "forbidden"): AppError =>
  appError(403, "forbidden", message)

export const notFound = (message = "not found"): AppError =>
  appError(404, "not_found", message)

export const conflict = (message: string): AppError =>
  appError(409, "conflict", message)

export const gone = (code: string, message: string): AppError =>
  appError(410, code, message)

export const invalid = (message: string): AppError =>
  appError(422, "invalid", message)

export const internal = (message: string, cause?: unknown): AppError =>
  appError(500, "internal", message, cause)

export const isAppError = (value: unknown): value is AppError =>
  typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "AppError"

export const validationIssuesFromCause = (
  cause: unknown
): ReadonlyArray<ValidationIssue> | undefined => {
  if (!Array.isArray(cause)) return undefined
  const issues = cause.filter((value): value is ValidationIssue =>
    typeof value === "object" && value !== null &&
    Array.isArray((value as { readonly path?: unknown }).path) &&
    typeof (value as { readonly message?: unknown }).message === "string"
  )
  return issues.length === cause.length ? issues : undefined
}
