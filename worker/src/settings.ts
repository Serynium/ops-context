import { Effect } from "effect"
import { invalidSettings, type InvalidSettings, type RepositoryUnavailable } from "./errors.js"
import { DEFAULT_REDACT_KEYS } from "./redact.js"
import { AppConfig, Database } from "./services.js"
import type { SettingsView } from "./types.js"
import { nowIso } from "./ids.js"

interface SettingRow {
  readonly key: string
  readonly value: string
}

const requiredSettingKeys = [
  "retention_days",
  "redact_keys",
  "setup_completed",
  "mcp_enabled"
] as const

const setValue = (key: string, value: string): Effect.Effect<void, RepositoryUnavailable, Database> =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* db.run(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, nowIso()]
    )
  })

const parseList = (value: string | null): ReadonlyArray<string> => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean)
  }
}

export const getSettings: Effect.Effect<SettingsView, RepositoryUnavailable, Database | AppConfig> =
  Effect.gen(function*() {
    const config = yield* AppConfig
    const db = yield* Database
    const rows = yield* db.namedAll<SettingRow>(
      "settings.load",
      `SELECT key, value FROM settings
       WHERE key IN (${requiredSettingKeys.map(() => "?").join(", ")})`,
      requiredSettingKeys
    )
    const values = new Map(rows.map((row) => [row.key, row.value]))
    const retentionText = values.get("retention_days") ?? null

    const parsedRetention = Number.parseInt(retentionText ?? "", 10)
    return {
      retention_days: Number.isInteger(parsedRetention) ? parsedRetention : config.defaultRetentionDays,
      redact_keys: parseList(values.get("redact_keys") ?? null),
      default_redact_keys: DEFAULT_REDACT_KEYS,
      setup_completed: values.get("setup_completed") === "true",
      mcp_enabled: values.get("mcp_enabled") === "true",
      mcp_access_configured: Boolean(config.mcpHost && config.accessMcpAudience)
    }
  })

export interface SettingsPatch {
  readonly retention_days?: number | undefined
  readonly redact_keys?: ReadonlyArray<string> | undefined
  readonly setup_completed?: boolean | undefined
  readonly mcp_enabled?: boolean | undefined
}

export const updateSettings = (patch: SettingsPatch): Effect.Effect<SettingsView, InvalidSettings | RepositoryUnavailable, Database | AppConfig> =>
  Effect.gen(function*() {
    if (patch.retention_days !== undefined) {
      if (!Number.isInteger(patch.retention_days) || patch.retention_days < 0 || patch.retention_days > 3650) {
        return yield* Effect.fail(invalidSettings("retention_days must be an integer between 0 and 3650"))
      }
      yield* setValue("retention_days", String(patch.retention_days))
    }

    if (patch.redact_keys !== undefined) {
      if (!Array.isArray(patch.redact_keys) || patch.redact_keys.some((key) => typeof key !== "string")) {
        return yield* Effect.fail(invalidSettings("redact_keys must be an array of strings"))
      }
      const clean = [...new Set(patch.redact_keys.map((key) => key.trim()).filter(Boolean))].slice(0, 100)
      yield* setValue("redact_keys", JSON.stringify(clean))
    }

    if (patch.setup_completed !== undefined) {
      yield* setValue("setup_completed", patch.setup_completed ? "true" : "false")
    }

    if (patch.mcp_enabled !== undefined) {
      yield* setValue("mcp_enabled", patch.mcp_enabled ? "true" : "false")
    }

    return yield* getSettings
  })
