#!/usr/bin/env node
import { webcrypto } from "node:crypto"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"

const base64url = (value) => Buffer.from(value).toString("base64url")

const argument = (name) => {
  const prefix = `${name}=`
  const inline = process.argv.find((entry) => entry.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? "" : ""
}

let subject = argument("--subject")
if (!subject) {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    subject = await rl.question("VAPID subject (mailto:you@example.com): ")
  } finally {
    rl.close()
  }
}
if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
  throw new Error("VAPID subject must start with mailto: or https://")
}

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
)
const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey)
const publicRaw = await webcrypto.subtle.exportKey("raw", pair.publicKey)

console.log("\nGenerated Web Push values\n")
console.log(`VAPID_PUBLIC_KEY=${base64url(publicRaw)}`)
console.log(`VAPID_PRIVATE_JWK=${JSON.stringify(privateJwk)}`)
console.log(`VAPID_SUBJECT=${subject}`)
console.log("\nUpload them with:")
console.log("  pnpm exec wrangler secret put VAPID_PUBLIC_KEY")
console.log("  pnpm exec wrangler secret put VAPID_PRIVATE_JWK")
console.log("  pnpm exec wrangler secret put VAPID_SUBJECT")
console.log("\nCloudflare Access replaces administrator passwords and MCP bearer tokens.")
console.log("Do not commit the generated values.")
