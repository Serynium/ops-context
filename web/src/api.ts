export type Level = "info" | "success" | "warning" | "error" | "critical"

export interface EventAction {
  readonly label: string
  readonly url: string
}

export interface EventGroup {
  readonly count: number
  readonly first_seen: string
  readonly last_seen: string
}

export interface Project {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly icon: string
  readonly notify: boolean
  readonly min_level: Level
  readonly created_at: string
  readonly updated_at: string
}

export interface ProjectCreated extends Project {
  readonly api_key: string
}

export interface EventItem {
  readonly id: string
  readonly external_id?: string
  readonly project_id: string
  readonly project_name: string
  readonly project_slug: string
  readonly project_icon: string
  readonly source: string
  readonly type: string
  readonly level: Level
  readonly title: string
  readonly body: string
  readonly fingerprint: string
  readonly data: Record<string, unknown>
  readonly actions: ReadonlyArray<EventAction>
  readonly occurred_at: string
  readonly created_at: string
  readonly silenced: boolean
  readonly silence_id?: string
  readonly group?: EventGroup
}

export interface EventPage {
  readonly events: ReadonlyArray<EventItem>
  readonly next_cursor?: string
}

export interface PushDevice {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly endpoint_host: string
  readonly user_agent: string
  readonly last_seen_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface Silence {
  readonly id: string
  readonly project_id: string | null
  readonly project_name: string | null
  readonly field: "fingerprint" | "title" | "source"
  readonly value: string
  readonly note: string
  readonly created_at: string
}

export interface Settings {
  readonly retention_days: number
  readonly redact_keys: ReadonlyArray<string>
  readonly default_redact_keys: ReadonlyArray<string>
  readonly setup_completed: boolean
  readonly mcp_enabled: boolean
  readonly mcp_token_set: boolean
}

export interface Status {
  readonly version: string
  readonly server: string
  readonly database: string
  readonly base_url: string
  readonly uptime_seconds: null
  readonly web_push: { readonly configured: boolean; readonly subject: string }
  readonly projects: number
  readonly events: number
  readonly subscriptions: number
  readonly enabled_subscriptions: number
  readonly last_push: unknown
  readonly retention_days: number
  readonly setup_completed: boolean
  readonly admin_auth: boolean
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

let onUnauthorized: (() => void) | undefined
export const setUnauthorizedHandler = (handler: () => void): void => {
  onUnauthorized = handler
}

const request = async <A>(method: string, path: string, body?: unknown): Promise<A> => {
  const init: RequestInit = { method, credentials: "same-origin" }
  if (body !== undefined) {
    init.headers = { "content-type": "application/json", "x-ops-context": "pwa" }
    init.body = JSON.stringify(body)
  }

  const response = await fetch(path, init)

  if (response.status === 204) return undefined as A
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }

  if (!response.ok) {
    const value = parsed as { error?: string; message?: string } | null
    if (response.status === 401) onUnauthorized?.()
    throw new ApiError(
      response.status,
      value?.error ?? "request_failed",
      value?.message ?? `Request failed with HTTP ${response.status}`
    )
  }
  return parsed as A
}

export const api = {
  me: () => request<{ auth_required: boolean; authenticated: boolean }>("GET", "/api/v1/auth/me"),
  login: (username: string, password: string) =>
    request<{ auth_required: boolean; authenticated: boolean }>("POST", "/api/v1/auth/login", { username, password }),
  logout: () => request<void>("POST", "/api/v1/auth/logout", {}),

  events: (params: Record<string, string | undefined> = {}) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
    return request<EventPage>("GET", `/api/v1/events${search.size ? `?${search}` : ""}`)
  },
  event: (id: string) => request<EventItem>("GET", `/api/v1/events/${encodeURIComponent(id)}`),
  eventGroup: (projectId: string, fingerprint: string, params: Record<string, string | undefined> = {}) =>
    api.events({
      ...params,
      project: projectId,
      fingerprint,
      grouped: "false",
      limit: params.limit ?? "100"
    }),
  unsilence: (id: string) => request<{ event: EventItem }>("POST", `/api/v1/events/${encodeURIComponent(id)}/unsilence`, {}),

  projects: () => request<{ projects: ReadonlyArray<Project> }>("GET", "/api/v1/projects"),
  createProject: (input: { name: string; icon?: string }) => request<ProjectCreated>("POST", "/api/v1/projects", input),
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "icon" | "notify" | "min_level">>) =>
    request<Project>("PATCH", `/api/v1/projects/${encodeURIComponent(id)}`, patch),
  deleteProject: (id: string) => request<void>("DELETE", `/api/v1/projects/${encodeURIComponent(id)}`, {}),
  rotateProjectKey: (id: string) => request<ProjectCreated>("POST", `/api/v1/projects/${encodeURIComponent(id)}/rotate-key`, {}),

  publicKey: () => request<{ public_key: string }>("GET", "/api/v1/push/public-key"),
  pushDevices: () => request<{ subscriptions: ReadonlyArray<PushDevice> }>("GET", "/api/v1/push/subscriptions"),
  registerPush: (name: string, subscription: PushSubscriptionJSON) =>
    request<PushDevice>("POST", "/api/v1/push/subscriptions", { name, subscription }),
  updatePush: (id: string, patch: { name?: string; enabled?: boolean }) =>
    request<PushDevice>("PATCH", `/api/v1/push/subscriptions/${encodeURIComponent(id)}`, patch),
  deletePush: (id: string) => request<void>("DELETE", `/api/v1/push/subscriptions/${encodeURIComponent(id)}`, {}),

  silences: () => request<{ silences: ReadonlyArray<Silence>; silenced_events: number }>("GET", "/api/v1/silences"),
  createSilence: (input: { project_id?: string; field: Silence["field"]; value: string; note?: string }) =>
    request<Silence>("POST", "/api/v1/silences", input),
  deleteSilence: (id: string) => request<void>("DELETE", `/api/v1/silences/${encodeURIComponent(id)}`, {}),

  settings: () => request<Settings>("GET", "/api/v1/settings"),
  updateSettings: (patch: Partial<Settings>) => request<Settings>("PATCH", "/api/v1/settings", patch),
  status: () => request<Status>("GET", "/api/v1/status"),
  test: (project_id?: string) => request<{ event: EventItem }>("POST", "/api/v1/test", project_id ? { project_id } : {})
}
