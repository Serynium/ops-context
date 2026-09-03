import type { Level } from "./api"

const LEVELS: ReadonlyArray<Level> = ["info", "success", "warning", "error", "critical"]

export type InboxSearch = {
  project?: string
  level?: Level
  source?: string
  fingerprint?: string
  search?: string
  silenced?: "true" | "false"
  since?: string
  until?: string
  grouped?: boolean
}

export const inboxSearch = (search: Record<string, unknown>): InboxSearch => ({
  ...(typeof search.project === "string" && search.project ? { project: search.project } : {}),
  ...(LEVELS.includes(search.level as Level) ? { level: search.level as Level } : {}),
  ...(typeof search.source === "string" && search.source ? { source: search.source } : {}),
  ...(typeof search.fingerprint === "string" && search.fingerprint ? { fingerprint: search.fingerprint } : {}),
  ...(typeof search.search === "string" && search.search ? { search: search.search } : {}),
  ...(search.silenced === "true" || search.silenced === "false" ? { silenced: search.silenced } : {}),
  ...(typeof search.since === "string" && search.since ? { since: search.since } : {}),
  ...(typeof search.until === "string" && search.until ? { until: search.until } : {}),
  ...(search.grouped === false || search.grouped === "false"
    ? { grouped: false }
    : {}),
})
