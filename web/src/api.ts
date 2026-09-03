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

interface ProjectPage {
  readonly projects: ReadonlyArray<Project>
  readonly next_cursor?: string
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

export interface EventAccepted {
  readonly id: string
  readonly accepted_at: string
  readonly status: "queued"
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

export interface Delivery {
  readonly id: string
  readonly event_id: string
  readonly subscription_id: string
  readonly subscription_name: string
  readonly status: "sent" | "failed" | "skipped"
  readonly response_status: number | null
  readonly error: string
  readonly attempted_at: string
}

export interface PushCredentialResult {
  readonly subscription: PushDevice
  readonly renewal_credential: string
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

interface SettingsWire {
  readonly retention_days: number
  readonly redact_keys: ReadonlyArray<string>
  readonly default_redact_keys: ReadonlyArray<string>
  readonly setup_completed: boolean
  readonly mcp_enabled: boolean
  readonly mcp_access_configured: boolean
}

export type Settings = SettingsWire

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
  readonly dead_jobs: number
  readonly failed_ingests: number
  readonly last_push: Delivery | null
  readonly retention_days: number
  readonly setup_completed: boolean
  readonly admin_auth: boolean
  readonly admin_auth_provider: "cloudflare-access"
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const request = async <A>(method: string, path: string, body?: unknown): Promise<A> => {
  const headers = new Headers({ "x-requested-with": "XMLHttpRequest" })
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers,
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json")
    headers.set("x-ops-context", "pwa")
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
    if (response.status === 401) window.location.reload()
    throw new ApiError(
      response.status,
      value?.error ?? "request_failed",
      value?.message ?? `Request failed with HTTP ${response.status}`,
    )
  }
  return parsed as A
}

const eventsRequest = (params: Record<string, string | undefined> = {}): Promise<EventPage> => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
  return request<EventPage>("GET", `/api/v1/events${search.size ? `?${search}` : ""}`)
}

export const api = {
  events: eventsRequest,
  event: (id: string) => request<EventItem>("GET", `/api/v1/events/${encodeURIComponent(id)}`),
  eventDeliveries: (id: string) =>
    request<{ deliveries: ReadonlyArray<Delivery> }>("GET", `/api/v1/events/${encodeURIComponent(id)}/deliveries`),
  eventGroup: (projectId: string, fingerprint: string, params: Record<string, string | undefined> = {}) =>
    eventsRequest({
      ...params,
      project: projectId,
      fingerprint,
      grouped: "false",
      limit: params.limit ?? "100",
    }),
  unsilence: (id: string) =>
    request<{ event: EventItem }>("POST", `/api/v1/events/${encodeURIComponent(id)}/unsilence`, {}),

  projects: async (): Promise<{ projects: ReadonlyArray<Project> }> => {
    const projects: Project[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("before", cursor);
      const page = await request<ProjectPage>("GET", `/api/v1/projects?${query}`);
      projects.push(...page.projects);
      cursor = page.next_cursor;
    } while (cursor);
    return { projects };
  },
  createProject: (input: { name: string; icon?: string }) => request<ProjectCreated>("POST", "/api/v1/projects", input),
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "icon" | "notify" | "min_level">>) =>
    request<Project>("PATCH", `/api/v1/projects/${encodeURIComponent(id)}`, patch),
  deleteProject: (id: string) => request<void>("DELETE", `/api/v1/projects/${encodeURIComponent(id)}`, {}),
  rotateProjectKey: (id: string) =>
    request<ProjectCreated>("POST", `/api/v1/projects/${encodeURIComponent(id)}/rotate-key`, {}),

  publicKey: () => request<{ public_key: string }>("GET", "/api/v1/push/public-key"),
  pushDevices: () => request<{ subscriptions: ReadonlyArray<PushDevice> }>("GET", "/api/v1/push/subscriptions"),
  registerPush: (name: string, enrollmentKey: string, subscription: PushSubscriptionJSON, reactivate: boolean) =>
    request<PushCredentialResult>("POST", "/api/v1/push/subscriptions", {
      name,
      enrollment_key: enrollmentKey,
      reactivate,
      subscription,
    }),
  updatePush: (id: string, patch: { name?: string; enabled?: boolean }) =>
    request<PushDevice>("PATCH", `/api/v1/push/subscriptions/${encodeURIComponent(id)}`, patch),
  deletePush: (id: string) => request<void>("DELETE", `/api/v1/push/subscriptions/${encodeURIComponent(id)}`, {}),

  silences: () => request<{ silences: ReadonlyArray<Silence>; silenced_events: number }>("GET", "/api/v1/silences"),
  createSilence: (input: { project_id?: string; field: Silence["field"]; value: string; note?: string }) =>
    request<Silence>("POST", "/api/v1/silences", input),
  deleteSilence: (id: string) => request<void>("DELETE", `/api/v1/silences/${encodeURIComponent(id)}`, {}),

  settings: () => request<Settings>("GET", "/api/v1/settings"),
  updateSettings: (patch: Partial<SettingsWire>) => request<SettingsWire>("PATCH", "/api/v1/settings", patch),
  status: () => request<Status>("GET", "/api/v1/status"),
  test: (project_id?: string) =>
    request<{ event: EventAccepted }>("POST", "/api/v1/test", project_id ? { project_id } : {}),
}
