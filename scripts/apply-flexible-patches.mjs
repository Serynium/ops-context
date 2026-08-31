import { readFile, writeFile } from "node:fs/promises"

const runner = await readFile("scripts/apply-architecture-hardening.mjs", "utf8")
const match = /const patches = (\[.*\])\nconst read =/su.exec(runner)
if (!match) throw new Error("Could not extract architecture hardening patches")

const patches = JSON.parse(match[1])
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
const flexiblePattern = (value) =>
  new RegExp(value.trim().split(/\s+/u).map(escape).join("\\s+"), "mu")

for (const patch of patches) {
  const content = await readFile(patch.path, "utf8")
  if (content.includes(patch.new)) continue
  if (content.includes(patch.old)) {
    await writeFile(patch.path, content.replace(patch.old, patch.new))
    continue
  }
  const pattern = flexiblePattern(patch.old)
  if (!pattern.test(content)) {
    throw new Error(`Missing expected text in ${patch.path}`)
  }
  await writeFile(patch.path, content.replace(pattern, patch.new.trim()))
}
