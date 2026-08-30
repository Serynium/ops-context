import { Effect } from "effect"
import { invalidSettings, type InvalidSettings, type RepositoryUnavailable } from "./errors.js"
import { DEFAULT_REDACT_KEYS } from "./redact.js"
import { SettingsRepository } from "./repositories.js"
import { AppConfig } from "./services.js"
import type { SettingsView } from "./types.js"
import { nowIso } from "./ids.js"

const setValue = (key: "retention_days" | "redact_keys" | "setup_completed" | "mcp_enabled", value: string): Effect.Effect<void, RepositoryUnavailable, SettingsRepository> =>
  Effect.gen(function*() {
    const settings = yield* SettingsRepository
    yield* settings.set(key, value, nowIso())
  })

export const getSettings: Effect.Effect<SettingsView, RepositoryUnavailable, SettingsRepository | AppConfig> =
  Effect.gen(function*() {
    const config = yield* AppConfig
    const settings = yield* SettingsRepository
    const values = yield* settings.get
    const retentionText = values.retentionDays

    const parsedRetention = Number.parseInt(retentionText ?? "", 10)
    return {
      retention_days: Number.isInteger(parsedRetention) ? parsedRetention : config.defaultRetentionDays,
      redact_keys: values.redactKeys,
      default_redact_keys: DEFAULT_REDACT_KEYS,
      setup_completed: values.setupCompleted === "true",
      mcp_enabled: values.mcpEnabled === "true",
      mcp_access_configured: Boolean(config.mcpHost && config.accessMcpAudience)
    }
  })

export interface SettingsPatch {
  readonly retention_days?: number | undefined
  readonly redact_keys?: ReadonlyArray<string> | undefined
  readonly setup_completed?: boolean | undefined
  readonly mcp_enabled?: boolean | undefined
}

export const updateSettings = (patch: SettingsPatch): Effect.Effect<SettingsView, InvalidSettings | RepositoryUnavailable, SettingsRepository | AppConfig> =>
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
