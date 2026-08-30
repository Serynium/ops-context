import { gzipSync } from "node:zlib"
import { readFile } from "node:fs/promises"

const metadataPath = new URL("../.worker-dist/bundle-meta.json", import.meta.url)
const metadata = JSON.parse(await readFile(metadataPath, "utf8"))
const outputEntry = Object.entries(metadata.outputs).find(
  ([path]) => path.endsWith(".js") && !path.endsWith(".js.map")
)

if (!outputEntry) {
  throw new Error("bundle metadata does not contain a JavaScript Worker output")
}

const [outputPath, output] = outputEntry
const bundle = await readFile(new URL(`../${outputPath}`, import.meta.url))
const groups = {
  "MCP SDK": 0,
  "Zod (MCP transitive dependency)": 0,
  "MCP adapter": 0,
  "Effect and Effect adapters": 0,
  "Other first-party Worker code": 0,
  Other: 0
}

for (const [path, contribution] of Object.entries(output.inputs)) {
  const bytes = contribution.bytesInOutput
  if (path.includes("node_modules/.pnpm/@modelcontextprotocol+")) {
    groups["MCP SDK"] += bytes
  } else if (path.includes("node_modules/.pnpm/zod@")) {
    groups["Zod (MCP transitive dependency)"] += bytes
  } else if (path === "worker/src/mcp.ts") {
    groups["MCP adapter"] += bytes
  } else if (
    path.includes("node_modules/.pnpm/effect@") ||
    path.includes("node_modules/.pnpm/@effect+")
  ) {
    groups["Effect and Effect adapters"] += bytes
  } else if (path.startsWith("worker/src/")) {
    groups["Other first-party Worker code"] += bytes
  } else {
    groups.Other += bytes
  }
}

const format = (bytes) => `${bytes.toLocaleString("en-US")} B`
const percent = (bytes) => `${((bytes / output.bytes) * 100).toFixed(1)}%`

console.log(`Worker bundle: ${format(output.bytes)} raw, ${format(gzipSync(bundle).byteLength)} gzip`)
for (const [name, bytes] of Object.entries(groups)) {
  console.log(`${name}: ${format(bytes)} (${percent(bytes)})`)
}

const mcpUpperBound =
  groups["MCP SDK"] +
  groups["Zod (MCP transitive dependency)"] +
  groups["MCP adapter"]
console.log(
  `MCP-attributable upper bound: ${format(mcpUpperBound)} (${percent(mcpUpperBound)})`
)
