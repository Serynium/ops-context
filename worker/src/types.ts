export const LEVELS = ["info", "success", "warning", "error", "critical"] as const
export type Level = (typeof LEVELS)[number]

export interface EventAction {
  readonly label: string
  readonly url: string
}

export interface EventGroup {
  readonly count: number
  readonly first_seen: string
  readonly last_seen: string
}

export interface Env {
  readonly DB: D1Database
  readonly PUSH_QUEUE: Queue<import("./queue-contract.js").QueueCommand>
  readonly ASSETS: Fetcher

  readonly OPS_BASE_URL?: string
  readonly OPS_APP_HOST?: string
readonly OPS_MCP_HOST?: string
readonly OPS_ACCESS_TEAM_DOMAIN?: string
readonly OPS_ACCESS_APP_AUD?: string
  readonly OPS_ACCESS_MCP_AUD?: string
  readonly OPS_LOCAL_ACCESS_BYPASS?: string
  readonly OPS_RETENTION_DAYS?: string
  readonly OPS_PUSH_MAX_ATTEMPTS?: string

  readonly VAPID_PUBLIC_KEY: string
  readonly VAPID_PRIVATE_JWK: string
  readonly VAPID_SUBJECT: string
}

export interface ProjectView {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly icon: string
  readonly notify: boolean
  readonly min_level: Level
  readonly created_at: string
  readonly updated_at: string
}

export interface EventView {
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

export interface PushSubscriptionView {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly endpoint_host: string
  readonly user_agent: string
  readonly last_seen_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface SettingsView {
  readonly retention_days: number
  readonly redact_keys: ReadonlyArray<string>
  readonly default_redact_keys: ReadonlyArray<string>
  readonly setup_completed: boolean
  readonly mcp_enabled: boolean
  readonly mcp_access_configured: boolean
}
