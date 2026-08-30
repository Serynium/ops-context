import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { AdministratorIdentity } from "./access.js"
import type { ApiFailure } from "./api-models.js"
import { Events, Projects, Settings } from "./application.js"
import { D1StructuredLoggerLive } from "./database-observability.js"
import { isApplicationError, type ApplicationError } from "./errors.js"
import type { EventPage, ListEventsInput } from "./events.js"
import {
  GetEventArguments,
  GetEventGroupArguments,
  ListEventsArguments,
  ListProjectsArguments,
  SearchEventsArguments,
  type EventFilterArguments
} from "./mcp-schemas.js"
import type { EventView } from "./types.js"

const readOnlyAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false
} as const

const trimmed = (value: string | undefined): string | undefined => {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

const requiredText = (value: string, name: string): string => {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

const toListInput = (
  args: EventFilterArguments,
  projectId: string | undefined,
  search?: string
): ListEventsInput => {
  const source = trimmed(args.source)
  const fingerprint = trimmed(args.fingerprint)
  const since = trimmed(args.since)
  const until = trimmed(args.until)
  const before = trimmed(args.before)

  return {
    ...(projectId ? { project: projectId } : {}),
    ...(args.level ? { level: args.level } : {}),
    ...(source ? { source } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(args.grouped !== undefined ? { grouped: String(args.grouped) } : {}),
    ...(args.silenced !== undefined ? { silenced: String(args.silenced) } : {}),
    ...(before ? { before } : {}),
    limit: String(args.limit ?? 25),
    ...(search ? { search } : {})
  }
}

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

const contentResult = <A extends object>(value: A) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
})

export interface McpToolFailure {
  readonly code: "invalid_argument" | "not_found" | "conflict" | "unavailable"
  readonly message: string
}

export const toMcpToolFailure = (failure: ApplicationError): McpToolFailure => {
  switch (failure._tag) {
    case "InvalidEvent":
    case "InvalidProject":
    case "InvalidSubscription":
    case "InvalidSilence":
    case "InvalidSettings":
    case "InvalidEventQuery":
      return { code: "invalid_argument", message: failure.message }
    case "ProjectNotFound":
    case "EventNotFound":
    case "SubscriptionNotFound":
    case "SilenceNotFound":
    case "InvalidProjectCredential":
      return { code: "not_found", message: failure.message }
    case "DuplicateExternalId":
    case "ProjectDeletionConflict":
      return { code: "conflict", message: failure.message }
    case "RepositoryUnavailable":
    case "QueueUnavailable":
    case "CryptographyUnavailable":
    case "DeliveryTemporarilyUnavailable":
    case "PushNotConfigured":
      return { code: "unavailable", message: "Tool service is temporarily unavailable" }
  }
}

const errorMessage = (error: unknown): string => {
  if (isApplicationError(error)) return toMcpToolFailure(error).message
  if (typeof error === "object" && error !== null) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === "string") return message
  }
  return error instanceof Error ? error.message : "Tool execution failed"
}

export const runMcpEffect = async <A, E extends ApplicationError>(
  effect: Effect.Effect<A, E>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(D1StructuredLoggerLive)))
  if (Exit.isSuccess(exit)) return exit.value

  const error = Cause.squash(exit.cause)
  const failure = isApplicationError(error)
    ? toMcpToolFailure(error)
    : { code: "unavailable", message: "Tool execution failed" } as const
  throw new Error(`${failure.code}: ${failure.message}`)
}

const secureResponse = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "same-origin")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

const accessFailureResponse = (failure: ApiFailure): Response => {
  const status = failure._tag === "ForbiddenError" ? 403 : 401
  return secureResponse(Response.json(
    { error: failure.error, message: failure.message },
    { status }
  ))
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
      const identity = yield* AdministratorIdentity

      const resolveProject = async (value: string | undefined) => {
        const selector = trimmed(value)
        if (!selector) return undefined
        const available = await runMcpEffect(projects.list)
        return available.find((project) => project.id === selector || project.slug === selector)
      }

      const handler = createMcpHandler(() => {
        const server = new McpServer(
          {
            name: "ops-context",
            title: "Ops Context",
            version: "0.3.0"
          },
          {
            instructions:
              "Ops Context stores operational events from applications. These tools are read-only. " +
              "Events belong to projects, and repeated fingerprints are occurrences of the same event within a project. " +
              "Start with list_projects, then list_events or search_events, and use get_event for complete structured context."
          }
        )

        server.registerTool(
          "list_projects",
          {
            title: "List projects",
            description: "List every project that sends operational events.",
            inputSchema: ListProjectsArguments,
            annotations: readOnlyAnnotations
          },
          async () => contentResult({ projects: await runMcpEffect(projects.list) })
        )

        server.registerTool(
          "list_events",
          {
            title: "List events",
            description: "List recent events newest first. Set grouped=true to collapse repeated fingerprints within each project.",
            inputSchema: ListEventsArguments,
            annotations: readOnlyAnnotations
          },
          async (args) => {
            const selector = trimmed(args.project)
            const project = await resolveProject(selector)
            if (selector && !project) throw new Error(`Unknown project: ${selector}`)
            const page = await runMcpEffect(events.list(toListInput(args, project?.id)))
            return contentResult(eventPageOutput(page))
          }
        )

        server.registerTool(
          "search_events",
          {
            title: "Search events",
            description: "Case-insensitive search across titles, bodies, sources, fingerprints, and structured context.",
            inputSchema: SearchEventsArguments,
            annotations: readOnlyAnnotations
          },
          async (args) => {
            const selector = trimmed(args.project)
            const project = await resolveProject(selector)
            if (selector && !project) throw new Error(`Unknown project: ${selector}`)
            const query = requiredText(args.query, "query")
            const page = await runMcpEffect(events.list(toListInput(args, project?.id, query)))
            return contentResult(eventPageOutput(page))
          }
        )

        server.registerTool(
          "get_event",
          {
            title: "Get event",
            description: "Get one event with its complete structured context and actions.",
            inputSchema: GetEventArguments,
            annotations: readOnlyAnnotations
          },
          async ({ id }) => contentResult(await runMcpEffect(events.get(requiredText(id, "id"))))
        )

        server.registerTool(
          "get_event_group",
          {
            title: "Get event group",
            description: "Get aggregate metadata, the latest event, and paginated occurrences for a project and fingerprint.",
            inputSchema: GetEventGroupArguments,
            annotations: readOnlyAnnotations
          },
          async (args) => {
            const selector = requiredText(args.project, "project")
            const fingerprint = requiredText(args.fingerprint, "fingerprint")
            const project = await resolveProject(selector)
            if (!project) throw new Error(`Unknown project: ${selector}`)
            const since = trimmed(args.since)
            const until = trimmed(args.until)
            const before = trimmed(args.before)
            const window: ListEventsInput = {
              project: project.id,
              fingerprint,
              ...(since ? { since } : {}),
              ...(until ? { until } : {})
            }
            const grouped = await runMcpEffect(events.list({ ...window, grouped: "true", limit: "1" }))
            const latest = grouped.events[0]
            if (!latest) {
              throw new Error(`No events with fingerprint ${fingerprint} in project ${selector}`)
            }
            const occurrences = await runMcpEffect(events.list({
              ...window,
              grouped: "false",
              ...(before ? { before } : {}),
              limit: String(args.limit ?? 25)
            }))
            const group = latest.group ?? {
              count: occurrences.events.length,
              first_seen: latest.created_at,
              last_seen: latest.created_at
            }
            return contentResult({
              project: project.name,
              project_id: project.id,
              fingerprint,
              count: group.count,
              first_seen: group.first_seen,
              last_seen: group.last_seen,
              latest,
              occurrences: occurrences.events.map(eventSummary),
              ...(occurrences.next_cursor ? { next_cursor: occurrences.next_cursor } : {})
            })
          }
        )

        return server
      }, {
        legacy: "stateless",
        responseMode: "json",
        onerror: (error) => console.error("MCP protocol error", error)
      })

      const authorize = (request: Request) =>
        identity.authenticateRequest(request, "mcp").pipe(
          Effect.map((principal) => ({ ok: true as const, principal })),
          Effect.catch((failure: ApiFailure) =>
            Effect.succeed({ ok: false as const, response: accessFailureResponse(failure) })
          )
        )

      const handle = (request: Request): Effect.Effect<Response> =>
        Effect.gen(function*() {
          if (request.method === "OPTIONS") {
            return new Response(null, {
              status: 204,
              headers: { allow: "POST, OPTIONS", "cache-control": "no-store" }
            })
          }

          const currentSettings = yield* settings.get
          if (!currentSettings.mcp_enabled) {
            return secureResponse(Response.json(
              { error: "not_found", message: "MCP is disabled" },
              { status: 404 }
            ))
          }
          if (!currentSettings.mcp_access_configured) {
            return secureResponse(Response.json(
              { error: "service_unavailable", message: "MCP Cloudflare Access is not configured" },
              { status: 503 }
            ))
          }

          const url = new URL(request.url)
          const host = request.headers.get("host")
          const origin = request.headers.get("origin")
          if ((host && host !== url.host) || (origin && origin !== url.origin)) {
            return secureResponse(Response.json(
              { error: "forbidden", message: "MCP host or origin is not allowed" },
              { status: 403 }
            ))
          }

          const access = yield* authorize(request)
          if (!access.ok) return access.response

          return yield* Effect.tryPromise({
            try: async () => secureResponse(await handler.fetch(request, {
              authInfo: {
                token: "cloudflare-access",
                clientId: access.principal.subject,
                scopes: ["events:read"]
              }
            })),
            catch: (error) => new Error(errorMessage(error))
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed(secureResponse(Response.json(
                { jsonrpc: "2.0", id: null, error: { code: -32603, message: errorMessage(error) } },
                { status: 500 }
              )))
            )
          )
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(secureResponse(Response.json(
              { jsonrpc: "2.0", id: null, error: { code: -32603, message: errorMessage(error) } },
              { status: 500 }
            )))
          )
        )

      return McpEndpoint.of({ handle })
    })
  )
}
