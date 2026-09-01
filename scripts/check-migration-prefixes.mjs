import { readdir } from "node:fs/promises"

const directory = new URL("../migrations/", import.meta.url)
const files = (await readdir(directory))
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort()

const byPrefix = new Map()
for (const file of files) {
  const prefix = file.slice(0, 4)
  const entries = byPrefix.get(prefix) ?? []
  entries.push(file)
  byPrefix.set(prefix, entries)
}

const grandfathered = new Map([
  ["0006", [
    "0006_queue_first_ingestion.sql",
    "0006_tune_event_indexes.sql"
  ]]
])

const errors = []
for (const [prefix, entries] of byPrefix) {
  if (entries.length === 1) continue
  const allowed = grandfathered.get(prefix)
  if (
    !allowed ||
    entries.length !== allowed.length ||
    entries.some((entry, index) => entry !== allowed[index])
  ) {
    errors.push(`${prefix}: ${entries.join(", ")}`)
  }
}

for (const [prefix, expected] of grandfathered) {
  const actual = byPrefix.get(prefix) ?? []
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    errors.push(
      `${prefix}: grandfathered set changed; expected ${expected.join(", ")}`
    )
  }
}

if (errors.length > 0) {
  console.error("Migration prefixes must be unique except for the immutable 0006 pair:")
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`Migration prefix check passed for ${files.length} migrations.`)
}
