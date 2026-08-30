import { Context, Effect, Layer } from "effect"
import type { ApiFailure } from "./api-models.js"
import { Events, Projects, Settings } from "./application.js"
import type { ListEventsInput } from "./events.js"
import {
  AppConfig,
  CredentialCrypto,
  Database,
  PasswordHasher
} from "./services.js"

const protocolVersion = "2025-06-18"

interface JsonRpcRequest {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

const tools: ReadonlyArray<ToolDefinition> = [
  {
    name: "list_projects",
    description: "List every Ops Context project.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_events",
    description: "List operational events with the same filters as the inbox.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        level: { type: "string", enum: ["info", "success", "warning", "error", "critical"] },
        source: { type: "string" },
        fingerprint: { type: "string" },
        since: { type: "string", format: "date-time" },
        until: { type: "string", format: "date-time" },
        grouped: { type: "boolean" },
        silenced: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "search_events",
    description: "Search event titles, bodies, sources, fingerprints, and structured context.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1 },
        project: { type: "string" },
        level: { type: "string", enum: ["info", "success", "warning", "error", "critical"] },
        source: { type: "string" },
        fingerprint: { type: "string" },
        since: { type: "string", format: "date-time" },
        until: { type: "string", format: "date-time" },
        grouped: { type: "boolean" },
        silenced: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_event",
    description: "Get one event by its id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "get_event_group",
    description: "List occurrences for one project and fingerprint.",
    inputSchema: {
      type: "object",
      required: ["project_id", "fingerprint"],
      properties: {
        project_id: { type: "string" },
        fingerprint: { type: "string", minLength: 1 },
        since: { type: "string", format: "date-time" },
        until: { type: "string", format: "date-time" },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  }
]

const json = (value: unknown, status = 200, version = protocolVersion): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "mcp-protocol-version": version,
      "x-content-type-options": "nosniff"
    }
  })

const rpcResult = (id: unknown, result: unknown): Response =>
  json({ jsonrpc: "2.0", id: id ?? null, result })

const rpcError = (id: unknown, code: number, message: string, status = 200): Response =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status)

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {}

const stringArgument = (
  args: Readonly<Record<string, unknown>>,
  key: string,
  required = false
): string | undefined => {
  const value = args[key]
  if (typeof value === "string" && value.trim()) return value.trim()
  if (required) throw new Error(`${key} is required`)
  return undefined
}

const booleanArgument = (
  args: Readonly<Record<string, unknown>>,
  key: string
): string | undefined => typeof args[key] === "boolean" ? String(args[key]) : undefined

const limitArgument = (args: Readonly<Record<string, unknown>>): string | undefined => {
  const value = args.limit
  return typeof value === "number" && Number.isInteger(value)
    ? String(Math.max(1, Math.min(100, value)))
    : undefined
}

const listInput = (
  args: Readonly<Record<string, unknown>>,
  search?: string
): ListEventsInput => ({
  ...(stringArgument(args, "project") ? { project: stringArgument(args, "project") } : {}),
  ...(stringArgument(args, "level") ? { level: stringArgument(args, "level") } : {}),
  ...(stringArgument(args, "source") ? { source: stringArgument(args, "source") } : {}),
  ...(stringArgument(args, "fingerprint") ? { fingerprint: stringArgument(args, "fingerprint") } : {}),
  ...(stringArgument(args, "since") ? { since: stringArgument(args, "since") } : {}),
  ...(stringArgument(args, "until") ? { until: stringArgument(args, "until") } : {}),
  ...(booleanArgument(args, "grouped") ? { grouped: booleanArgument(args, "grouped") } : {}),
  ...(booleanArgument(args, "silenced") ? { silenced: booleanArgument(args, "silenced") } : {}),
  ...(limitArgument(args) ? { limit: limitArgument(args) } : {}),
  ...(search ? { search } : {})
})

const contentResult = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value
})

const toolError = (message: string) => ({
  isError: true,
  content: [{ type: "text", text: message }]
})

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === "string") return message
  }
  return error instanceof Error ? error.message : "Tool execution failed"
}

const parseCookies = (request: Request): Readonly<Record<string, string>> => {
  const cookies: Record<string, string> = {}
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=")
    if (separator < 1) continue
    const key = part.slice(0, separator).trim()
    const raw = part.slice(separator + 1).trim()
    try {
      cookies[key] = decodeURIComponent(raw)
    } catch {
      cookies[key] = raw
    }
  }
  return cookies
}

const parseBasic = (header: string): { readonly username: string; readonly password: string } | undefined => {
  try {
    const decoded = atob(header.slice("Basic ".length))
    const separator = decoded.indexOf(":")
    return separator < 0
      ? undefined
      : { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
  } catch {
    return undefined
  }
}

export class McpEndpoint extends Context.Service<McpEndpoint, {
  readonly handle: (request: Request) => Effect.Effect<Response>
}>()("ops-context/McpEndpoint") {
  static readonly layer = Layer.effect(
    McpEndpoint,
    Effect.gen(function*() {
      const projects = yield* Projects
      const events = yield* Events
      const settings = yield* Settings
      const config = yield* AppConfig
      const database = yield* Database
      const credentials = yield* CredentialCrypto
      const passwordHasher = yield* PasswordHasher

      const hasAdminSession = Effect.fn("Mcp.hasAdminSession")(function*(request: Request) {
        const token = parseCookies(request).ops_session
        if (!token) return false
        const tokenHash = yield* credentials.sha256Hex(token).pipe(Effect.catch(() => Effect.succeed("")))
        if (!tokenHash) return false
        const row = yield* database.first<{ readonly token_hash: string }>(
          "SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?",
          [tokenHash, new Date().toISOString()]
        ).pipe(Effect.catch(() => Effect.succeed(null)))
        return row !== null
      })

      const hasBasicCredentials = Effect.fn("Mcp.hasBasicCredentials")(function*(request: Request) {
        const authorization = request.headers.get("authorization")
        if (!authorization?.startsWith("Basic ")) return false
        const parsed = parseBasic(authorization)
        if (!parsed || parsed.username !== config.adminUser) return false
        return yield* passwordHasher.verify(parsed.password, config.adminPasswordHash).pipe(
          Effect.catch(() => Effect.succeed(false))
        )
      })

      const bearerDecision = Effect.fn("Mcp.bearerDecision")(function*(request: Request) {
        const authorization = request.headers.get("authorization")
        if (!authorization?.startsWith("Bearer ")) return "none" as const
        const presented = authorization.slice("Bearer ".length).trim()
        if (!presented || !config.mcpToken || config.mcpToken.length < 16) return "project-key" as const
        const [presentedHash, configuredHash] = yield* Effect.all([
          credentials.sha256Hex(presented),
          credentials.sha256Hex(config.mcpToken)
        ]).pipe(Effect.catch(() => Effect.succeed(["", ""] as const)))
        return presentedHash && presentedHash === configuredHash ? "mcp" as const : "project-key" as const
      })

      const authorized = Effect.fn("Mcp.authorized")(function*(request: Request) {
        const bearer = yield* bearerDecision(request)
        if (bearer === "mcp") return { ok: true as const }
        if (bearer === "project-key") {
          return {
            ok: false as const,
            response: json({ error: "forbidden", message: "project API keys cannot access MCP" }, 403)
          }
        }
        if (yield* hasAdminSession(request)) return { ok: true as const }
        if (yield* hasBasicCredentials(request)) return { ok: true as const }
        return {
          ok: false as const,
          response: json({ error: "unauthorized", message: "MCP authentication is required" }, 401)
        }
      })

      const callTool = Effect.fn("Mcp.callTool")(function*(name: string, args: Readonly<Record<string, unknown>>) {
        let effect: Effect.Effect<unknown, ApiFailure>
        switch (name) {
          case "list_projects":
            effect = projects.list
            break
          case "list_events":
            effect = events.list(listInput(args))
            break
          case "search_events": {
            const query = stringArgument(args, "query", true)!
            effect = events.list(listInput(args, query))
            break
          }
          case "get_event":
            effect = events.get(stringArgument(args, "id", true)!)
            break
          case "get_event_group":
            effect = events.list({
              project: stringArgument(args, "project_id", true)!,
              fingerprint: stringArgument(args, "fingerprint", true)!,
              ...(stringArgument(args, "since") ? { since: stringArgument(args, "since") } : {}),
              ...(stringArgument(args, "until") ? { until: stringArgument(args, "until") } : {}),
              grouped: "false",
              limit: limitArgument(args) ?? "100"
            })
            break
          default:
            return toolError(`Unknown tool: ${name}`)
        }
        return yield* effect.pipe(
          Effect.map(contentResult),
          Effect.catch((error) => Effect.succeed(toolError(errorMessage(error))))
        )
      })

      const dispatch = Effect.fn("Mcp.dispatch")(function*(request: JsonRpcRequest) {
        const id = request.id ?? null
        if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
          return rpcError(id, -32600, "Invalid JSON-RPC request", 400)
        }

        switch (request.method) {
          case "initialize": {
            const params = asRecord(request.params)
            const requestedVersion = typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : protocolVersion
            return rpcResult(id, {
              protocolVersion: requestedVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "ops-context", version: "0.3.0" },
              instructions: "Read-only access to projects, events, event search, and fingerprint groups."
            })
          }
          case "server/discover":
            return rpcResult(id, {
              protocolVersions: ["2026-07-28", protocolVersion],
              capabilities: { tools: {} },
              serverInfo: { name: "ops-context", version: "0.3.0" }
            })
          case "ping":
            return rpcResult(id, {})
          case "notifications/initialized":
            return new Response(null, { status: 202 })
          case "tools/list":
            return rpcResult(id, { tools })
          case "tools/call": {
            const params = asRecord(request.params)
            if (typeof params.name !== "string") return rpcError(id, -32602, "Tool name is required")
            const result = yield* callTool(params.name, asRecord(params.arguments))
            return rpcResult(id, result)
          }
          default:
            return rpcError(id, -32601, `Method not found: ${request.method}`)
        }
      })

      const handle = (request: Request): Effect.Effect<Response> =>
        Effect.gen(function*() {
          if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } })
          }

          const currentSettings = yield* settings.get
          if (!currentSettings.mcp_enabled) {
            return json({ error: "not_found", message: "MCP is disabled" }, 404)
          }

          const access = yield* authorized(request)
          if (!access.ok) return access.response
          if (request.method !== "POST") {
            return json({ error: "method_not_allowed", message: "Use POST for MCP Streamable HTTP" }, 405)
          }

          const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10)
          if (contentLength > 1_048_576) return rpcError(null, -32600, "Request body is too large", 413)

          const payload = yield* Effect.tryPromise({
            try: () => request.json() as Promise<JsonRpcRequest>,
            catch: () => new Error("Request body is not valid JSON")
          })
          return yield* dispatch(payload)
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(rpcError(null, -32603, errorMessage(error), 500))
          )
        )

      return McpEndpoint.of({ handle })
    })
  )
}
