#!/usr/bin/env node
import { pbkdf2Sync, randomBytes, webcrypto } from "node:crypto"
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

const hiddenQuestion = (prompt) => {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const rl = createInterface({ input: stdin, output: stdout })
    return rl.question(prompt).finally(() => rl.close())
  }

  return new Promise((resolve, reject) => {
    let value = ""
    stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")

    const cleanup = () => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write("\n")
    }

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup()
          resolve(value)
          return
        }
        if (character === "\u0003") {
          cleanup()
          reject(new Error("Cancelled"))
          return
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1)
            stdout.write("\b \b")
          }
          continue
        }
        if (character >= " ") {
          value += character
          stdout.write("*")
        }
      }
    }

    stdin.on("data", onData)
  })
}

const password = argument("--password") || await hiddenQuestion("Administrator password: ")
if (password.length < 12) throw new Error("Use an administrator password of at least 12 characters")

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

const iterations = 310_000
const salt = randomBytes(16)
const passwordHash = pbkdf2Sync(password, salt, iterations, 32, "sha256")
const encodedPassword = `pbkdf2-sha256$${iterations}$${base64url(salt)}$${base64url(passwordHash)}`
const mcpToken = base64url(randomBytes(32))

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
)
const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey)
const publicRaw = await webcrypto.subtle.exportKey("raw", pair.publicKey)

console.log("\nGenerated values\n")
console.log(`ADMIN_PASSWORD_HASH=${encodedPassword}`)
console.log(`OPS_MCP_TOKEN=${mcpToken}`)
console.log(`VAPID_PUBLIC_KEY=${base64url(publicRaw)}`)
console.log(`VAPID_PRIVATE_JWK=${JSON.stringify(privateJwk)}`)
console.log(`VAPID_SUBJECT=${subject}`)
console.log("\nUpload them with:")
console.log("  pnpm exec wrangler secret put ADMIN_PASSWORD_HASH")
console.log("  pnpm exec wrangler secret put OPS_MCP_TOKEN")
console.log("  pnpm exec wrangler secret put VAPID_PUBLIC_KEY")
console.log("  pnpm exec wrangler secret put VAPID_PRIVATE_JWK")
console.log("  pnpm exec wrangler secret put VAPID_SUBJECT")
console.log("\nDo not commit the generated values.")
