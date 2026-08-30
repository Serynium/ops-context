import { Context, Effect, Layer } from "effect"
import type { ApiFailure } from "./api-models.js"
import { Events, Projects, Settings } from "./application.js"
import type { EventPage, ListEventsInput } from "./events.js"
import {
  AppConfig,
  CredentialCrypto,
  Database,
  PasswordHasher
} from "./services.js"
import type { EventView, ProjectView } from "./types.js"

const protocolVersion = "2026-07-28"
const supportedProtocolVersions = new Set([protocolVersion, "2025-06-18"])
const readOnlyAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false
} as const

interface JsonRpcRequest {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

interface ToolDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly annotations: typeof readOnlyAnnotations
}

const commonEventProperties = {
  project: { type: "string", description: "Project id or slug" },
  level: { type: "string", enum: ["info", "success", "warning", "error", "critical"] },
  source: { type: "string" },
  fingerprint: { type: "string" },
  since: { type: "string", format: "date-time" },
  until: { type: "string", format: "date-time" },
  grouped: { type: "boolean" },
  silenced: { type: "boolean" },
  before: { type: "string", description: "Cursor returned by a previous call" },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
} as const

const tools: ReadonlyArray<ToolDefinition> = [
  {
    name: "list_projects",
    title: "List projects",
    description: "List every project that sends operational events.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnlyAnnotations
  },
  {
    name: "list_events",
    title: "List events",
    description: "List recent events newest first. Set grouped=true to collapse repeated fingerprints within each project.",
    inputSchema: {
      type: "object",
      properties: commonEventProperties,
      additionalProperties: false
    },
    annotations: readOnlyAnnotations
  },
  {
    name: "search_events",
    title: "Search events",
    description: "Case-insensitive search across titles, bodies, sources, fingerprints, and structured context.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1 },
        ...commonEventProperties
      },
      additionalProperties: false
    },
    annotations: readOnlyAnnotations
  },
  {
    name: "get_event",
    title: "Get event",
    description: "Get one event with its complete structured context and actions.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false
    },
    annotations: readOnlyAnnotations
  },
  {
    name: "get_event_group",
    title: "Get event group",
    description: "Get aggregate metadata, the latest event, and paginated occurrences for a project and fingerprint.",
    inputSchema: {
      type: "object",
      required: ["project", "fingerprint"],
      properties: {
        project: { type: "string", description: "Project id or slug" },
        fingerprint: { type: "string", minLength: 1 },
        since: { type: "string", format: "date-time" },
        until: { type: "string", format: "date-time" },
        before: { type: "string", description: "Cursor returned by a previous call" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
      },
      additionalProperties: false
    },
    annotations: readOnlyAnnotations
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
  key: string
): string | undefined => {
  const value = args[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

const booleanArgument = (
  args: Readonly<Record<string, unknown>>,
  key: string
): string | undefined => typeof args[key] === "boolean" ? String(args[key]) : undefined

const limitArgument = (args: Readonly<Record<string, unknown>>, fallback = 25): string => {
  const value = args.limit
  return typeof value === "number" && Number.isInteger(value)
    ? String(Math.max(1, Math.min(100, value)))
    : String(fallback)
}

const listInput = (
  args: Readonly<Record<string, unknown>>,
  projectId: string | undefined,
  search?: string
): ListEventsInput => ({
  ...(projectId ? { project: projectId } : {}),
  ...(stringArgument(args, "level") ? { level: stringArgument(args, "level") } : {}),
  ...(stringArgument(args, "source") ? { source: stringArgument(args, "source") } : {}),
  ...(stringArgument(args, "fingerprint") ? { fingerprint: stringArgument(args, "fingerprint") } : {}),
  ...(stringArgument(args, "since") ? { since: stringArgument(args, "since") } : {}),
  ...(stringArgument(args, "until") ? { until: stringArgument(args, "until") } : {}),
  ...(booleanArgument(args, "grouped") ? { grouped: booleanArgument(args, "grouped") } : {}),
  ...(booleanArgument(args, "silenced") ? { silenced: booleanArgument(args, "silenced") } : {}),
  ...(stringArgument(args, "before") ? { before: stringArgument(args, "before") } : {}),
  limit: limitArgument(args),
  ...(search ? { search } : {})
})

const eventSummary = (event: EventView) => ({
  id: event.id,
  project: event.project_name,
  project_id: event.project_id,
  level: event.level,
  title: event.title,
  ...(event.body ? { body: event.body } : {}),
  ...(event.source ? { source: event.source } : {}),
  ...(event.type ? { type: event.type } : {}),
  ...(event.fingerprint ? { fingerprint: event.fingerprint } : {}),
  ...(event.external_id ? { external_id: event.external_id } : {}),
  occurred_at: event.occurred_at,
  created_at: event.created_at,
  ...(event.silenced ? { silenced: true } : {}),
  ...(Object.keys(event.data).length > 0 ? { data_keys: Object.keys(event.data).sort() } : {}),
  ...(event.actions.length > 0 ? { actions: event.actions } : {}),
  ...(event.group ? { group: event.group } : {})
})

const eventPageOutput = (page: EventPage) => ({
  events: page.events.map(eventSummary),
  ...(page.next_cursor ? { next_cursor: page.next_cursor } : {})
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

      const resolveProject = Effect.fn("Mcp.resolveProject")(function*(value: string | undefined) {
        if (!value) return undefined
        const available = yield* projects.list
        return available.find((project) => project.id === value || project.slug === value)
      })

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
        if (!presented) return "invalid" as const

        if (config.mcpToken && config.mcpToken.length >= 16) {
          const [presentedHash, configuredHash] = yield* Effect.all([
            credentials.sha256Hex(presented),
            credentials.sha256Hex(config.mcpToken)
          ]).pipe(Effect.catch(() => Effect.succeed(["", ""] as const)))
          if (presentedHash && presentedHash === configuredHash) return "mcp" as const
        }

        const projectKey = yield* projects.authenticate(presented).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false))
        )
        return projectKey ? "project-key" as const : "invalid" as const
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
        if (bearer === "invalid") {
          return {
            ok: false as const,
            response: json({ error: "unauthorized", message: "invalid MCP bearer token" }, 401)
          }
        }
        if (yield* hasAdminSession(request)) return { ok: true as const }
        if (yield* hasBasicCredentials(request)) return { ok: true as const }
        return {
          ok: false as const,
          response: json({ error: "unauthorized", message: "MCP authentication is required" }, 401)
        }
      })

      const runTool = <A>(effect: Effect.Effect<A, ApiFailure>) =>
        effect.pipe(
          Effect.map(contentResult),
          Effect.catch((error) => Effect.succeed(toolError(errorMessage(error))))
        )

      const projectForArgs = Effect.fn("Mcp.projectForArgs")(function*(args: Readonly<Record<string, unknown>>) {
        const requested = stringArgument(args, "project")
        if (!requested) return { requested: undefined, project: undefined }
        return { requested, project: yield* resolveProject(requested) }
      })

      const callTool = Effect.fn("Mcp.callTool")(function*(name: string, args: Readonly<Record<string, unknown>>) {
        switch (name) {
          case "list_projects":
            return yield* runTool(projects.list.pipe(
              Effect.map((available) => ({ projects: available }))
            ))

          case "list_events": {
            const resolved = yield* projectForArgs(args)
            if (resolved.requested && !resolved.project) return toolError(`Unknown project: ${resolved.requested}`)
            return yield* runTool(events.list(listInput(args, resolved.project?.id)).pipe(
              Effect.map(eventPageOutput)
            ))
          }

          case "search_events": {
            const query = stringArgument(args, "query")
            if (!query) return toolError("query is required")
            const resolved = yield* projectForArgs(args)
            if (resolved.requested && !resolved.project) return toolError(`Unknown project: ${resolved.requested}`)
            return yield* runTool(events.list(listInput(args, resolved.project?.id, query)).pipe(
              Effect.map(eventPageOutput)
            ))
          }

          case "get_event": {
            const id = stringArgument(args, "id")
            if (!id) return toolError("id is required")
            return yield* runTool(events.get(id))
          }

          case "get_event_group": {
            const projectArgument = stringArgument(args, "project")
            const fingerprint = stringArgument(args, "fingerprint")
            if (!projectArgument || !fingerprint) return toolError("project and fingerprint are required")
            const project = yield* resolveProject(projectArgument)
            if (!project) return toolError(`Unknown project: ${projectArgument}`)

            const window: ListEventsInput = {
              project: project.id,
              fingerprint,
              ...(stringArgument(args, "since") ? { since: stringArgument(args, "since") } : {}),
              ...(stringArgument(args, "until") ? { until: stringArgument(args, "until") } : {})
            }
            const groupEffect = Effect.gen(function*() {
              const grouped = yield* events.list({ ...window, grouped: "true", limit: "1" })
              const latest = grouped.events[0]
              if (!latest) return toolError(`No events with fingerprint ${fingerprint} in project ${projectArgument}`)
              const occurrences = yield* events.list({
                ...window,
                grouped: "false",
                ...(stringArgument(args, "before") ? { before: stringArgument(args, "before") } : {}),
                limit: limitArgument(args)
              })
              const group = latest.group ?? {
                count: occurrences.events.length,
                first_seen: latest.created_at,
                last_seen: latest.created_at
              }
              return {
                project: project.name,
                project_id: project.id,
                fingerprint,
                count: group.count,
                first_seen: group.first_seen,
                last_seen: group.last_seen,
                latest,
                occurrences: occurrences.events.map(eventSummary),
                ...(occurrences.next_cursor ? { next_cursor: occurrences.next_cursor } : {})
              }
            })
            return yield* runTool(groupEffect)
          }

          default:
            return toolError(`Unknown tool: ${name}`)
        }
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
            const negotiatedVersion = supportedProtocolVersions.has(requestedVersion)
              ? requestedVersion
              : protocolVersion
            return rpcResult(id, {
              protocolVersion: negotiatedVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "ops-context", title: "Ops Context", version: "0.3.0" },
              instructions: "Ops Context stores operational events from applications. These tools are read-only. Repeated fingerprints are occurrences of the same event within a project."
            })
          }
          case "server/discover":
            return rpcResult(id, {
              protocolVersions: Array.from(supportedProtocolVersions),
              capabilities: { tools: {} },
              serverInfo: { name: "ops-context", title: "Ops Context", version: "0.3.0" }
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

          const requestVersion = request.headers.get("mcp-protocol-version")
          if (requestVersion && !supportedProtocolVersions.has(requestVersion)) {
            return rpcError(null, -32600, `Unsupported MCP protocol version: ${requestVersion}`, 400)
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
