export const LEVELS = ["info", "success", "warning", "error", "critical"] as const
export type Level = (typeof LEVELS)[number]

export interface PushJobMessage {
  readonly eventId: string
  readonly subscriptionId: string
}

export interface Env {
  readonly DB: D1Database
  readonly PUSH_QUEUE: Queue<PushJobMessage>
  readonly ASSETS: Fetcher

  readonly OPS_BASE_URL?: string
  readonly OPS_ADMIN_USER: string
  readonly OPS_RETENTION_DAYS?: string

  readonly ADMIN_PASSWORD_HASH: string
  readonly VAPID_PUBLIC_KEY: string
  readonly VAPID_PRIVATE_JWK: string
  readonly VAPID_SUBJECT: string
}

export interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly icon: string
  readonly api_key_hash: string
  readonly notify: number
  readonly min_level: Level
  readonly created_at: string
  readonly updated_at: string
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

export interface EventRow {
  readonly id: string
  readonly external_id: string | null
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
  readonly payload_json: string
  readonly occurred_at: string
  readonly created_at: string
  readonly silence_id: string | null
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
  readonly occurred_at: string
  readonly created_at: string
  readonly silenced: boolean
  readonly silence_id?: string
}

export interface PushSubscriptionRow {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
  readonly user_agent: string
  readonly enabled: number
  readonly last_seen_at: string | null
  readonly created_at: string
  readonly updated_at: string
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

export interface SilenceRow {
  readonly id: string
  readonly project_id: string | null
  readonly project_name: string | null
  readonly field: "fingerprint" | "title" | "source"
  readonly value: string
  readonly note: string
  readonly created_at: string
}

export interface DeliveryRow {
  readonly id: string
  readonly event_id: string
  readonly subscription_id: string
  readonly subscription_name: string
  readonly status: "sent" | "failed" | "skipped"
  readonly response_status: number | null
  readonly error: string
  readonly attempted_at: string
}

export interface SettingsView {
  readonly retention_days: number
  readonly redact_keys: ReadonlyArray<string>
  readonly default_redact_keys: ReadonlyArray<string>
  readonly setup_completed: boolean
}
