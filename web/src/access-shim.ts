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
