// Temporary compatibility for the existing single-file PWA entry while its
// view code is split into modules. No password form is rendered. Any legacy
// attempt to open the old login dialog restarts the Cloudflare Access flow.
const host = document.createElement("div")
host.hidden = true
host.innerHTML = `
  <dialog id="login-dialog">
    <form id="login-form">
      <input id="login-username" name="username" />
      <input id="login-password" name="password" type="password" />
      <p id="login-error"></p>
    </form>
  </dialog>`

document.body.append(host)

const dialog = host.querySelector<HTMLDialogElement>("#login-dialog")!
dialog.showModal = () => window.location.reload()

const rewriteMcpCallout = (): void => {
  for (const callout of document.querySelectorAll<HTMLElement>(".callout")) {
    if (!callout.textContent?.includes("MCP Streamable HTTP")) continue
    const configured = !callout.classList.contains("warning")
    callout.innerHTML = `
      <strong>MCP Streamable HTTP:</strong> use the dedicated MCP hostname protected by Cloudflare Access.<br />
      Access policy: ${configured
        ? "configured"
        : "not configured — set OPS_MCP_HOST and OPS_ACCESS_MCP_AUD"}`
  }
}

new MutationObserver(rewriteMcpCallout).observe(
  document.querySelector("#app")!,
  { childList: true, subtree: true }
)
