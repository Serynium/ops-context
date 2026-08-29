import "./styles.css"
import {
  ApiError,
  api,
  setUnauthorizedHandler,
  type EventItem,
  type Level,
  type Project,
  type PushDevice,
  type Silence
} from "./api.js"

type View = "inbox" | "projects" | "push" | "silences" | "settings"

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
  prompt(): Promise<void>
}

const app = document.querySelector<HTMLElement>("#app")!
const loginDialog = document.querySelector<HTMLDialogElement>("#login-dialog")!
const loginForm = document.querySelector<HTMLFormElement>("#login-form")!
const loginError = document.querySelector<HTMLElement>("#login-error")!
const installButton = document.querySelector<HTMLButtonElement>("#install-button")!
const pushButton = document.querySelector<HTMLButtonElement>("#push-button")!
const logoutButton = document.querySelector<HTMLButtonElement>("#logout-button")!
const keyDialog = document.querySelector<HTMLDialogElement>("#key-dialog")!
const keyValue = document.querySelector<HTMLElement>("#key-value")!
const copyKeyButton = document.querySelector<HTMLButtonElement>("#copy-key")!
const toast = document.querySelector<HTMLElement>("#toast")!

let currentView: View = "inbox"
let installPrompt: BeforeInstallPromptEvent | undefined
let toastTimer: number | undefined

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")

const formatDate = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date)
}

const notify = (message: string): void => {
  window.clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.add("visible")
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3_200)
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Something went wrong"

const showLogin = (): void => {
  if (!loginDialog.open) loginDialog.showModal()
  window.setTimeout(() => document.querySelector<HTMLInputElement>("#login-username")?.focus(), 50)
}

const showKey = (key: string): void => {
  keyValue.textContent = key
  if (!keyDialog.open) keyDialog.showModal()
}

const setActiveNav = (): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".nav [data-view]")) {
    button.classList.toggle("active", button.dataset.view === currentView)
  }
}

const loading = (): void => {
  app.innerHTML = `<section class="panel loading-panel"><div class="spinner"></div><p>Loading…</p></section>`
}

const empty = (title: string, body: string): string =>
  `<div class="empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p></div>`

const levelBadge = (level: Level): string =>
  `<span class="badge ${level}">${escapeHtml(level)}</span>`

const eventMarkup = (event: EventItem): string => {
  const usefulSilenceField = event.fingerprint
    ? ["fingerprint", event.fingerprint]
    : event.source
      ? ["source", event.source]
      : ["title", event.title]
  return `
    <article class="event" id="event-${escapeHtml(event.id)}">
      <div class="event-head">
        <div class="event-title">
          <span class="project-icon">${escapeHtml(event.project_icon || "🔔")}</span>
          <div>
            <h2>${escapeHtml(event.title)}</h2>
            ${event.body ? `<p>${escapeHtml(event.body)}</p>` : ""}
          </div>
        </div>
        <div>${levelBadge(event.level)} ${event.silenced ? '<span class="badge silenced">silenced</span>' : ""}</div>
      </div>
      <div class="meta">
        <span>${escapeHtml(event.project_name)}</span>
        ${event.source ? `<span>· ${escapeHtml(event.source)}</span>` : ""}
        <span>· ${escapeHtml(formatDate(event.occurred_at))}</span>
      </div>
      <details>
        <summary>Context</summary>
        <pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
      </details>
      <div class="event-actions">
        ${event.silenced
          ? `<button class="button small secondary" data-action="unsilence" data-event-id="${escapeHtml(event.id)}">Unsilence and push</button>`
          : `<button class="button small ghost" data-action="silence-event" data-event-id="${escapeHtml(event.id)}" data-project-id="${escapeHtml(event.project_id)}" data-field="${escapeHtml(usefulSilenceField[0])}" data-value="${escapeHtml(usefulSilenceField[1])}">Silence similar</button>`}
      </div>
    </article>`
}

const attachEventActions = (root: ParentNode = document): void => {
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-action='unsilence']")) {
    button.addEventListener("click", async () => {
      button.disabled = true
      try {
        await api.unsilence(button.dataset.eventId!)
        notify("Event unsilenced and queued for push")
        await renderInbox()
      } catch (cause) {
        notify(errorMessage(cause))
      } finally {
        button.disabled = false
      }
    })
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-action='silence-event']")) {
    button.addEventListener("click", async () => {
      const field = button.dataset.field as Silence["field"]
      const value = button.dataset.value ?? ""
      if (!window.confirm(`Silence future events where ${field} equals “${value}”?`)) return
      button.disabled = true
      try {
        const projectId = button.dataset.projectId
        await api.createSilence({
          ...(projectId ? { project_id: projectId } : {}),
          field,
          value,
          note: "Created from inbox"
        })
        notify("Silence rule created")
      } catch (cause) {
        notify(errorMessage(cause))
      } finally {
        button.disabled = false
      }
    })
  }
}

const renderInbox = async (): Promise<void> => {
  loading()
  const [{ projects }, page] = await Promise.all([api.projects(), api.events({ limit: "50" })])
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Inbox</h1><p>Everything your systems decided was worth knowing about.</p></div>
      <div class="page-actions"><button id="refresh-inbox" class="button secondary">Refresh</button></div>
    </div>
    <section class="panel">
      <form id="event-filters" class="form-row">
        <label>Project
          <select name="project">
            <option value="">All projects</option>
            ${projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}
          </select>
        </label>
        <label>Level
          <select name="level">
            <option value="">All levels</option>
            ${["info", "success", "warning", "error", "critical"].map((level) => `<option>${level}</option>`).join("")}
          </select>
        </label>
        <label>Visibility
          <select name="silenced">
            <option value="">All events</option>
            <option value="false">Not silenced</option>
            <option value="true">Silenced</option>
          </select>
        </label>
        <button class="button primary" type="submit">Apply</button>
      </form>
    </section>
    <section class="panel">
      <div id="event-list" class="event-list">
        ${page.events.length ? page.events.map(eventMarkup).join("") : empty("No events yet", "Create a project and POST your first operational event.")}
      </div>
      ${page.next_cursor ? `<div class="event-actions"><button id="load-more" class="button secondary" data-cursor="${escapeHtml(page.next_cursor)}">Load more</button></div>` : ""}
    </section>`

  attachEventActions(app)
  document.querySelector<HTMLButtonElement>("#refresh-inbox")?.addEventListener("click", () => void renderInbox())

  document.querySelector<HTMLFormElement>("#event-filters")?.addEventListener("submit", async (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget as HTMLFormElement)
    const filtered = await api.events({
      project: String(form.get("project") ?? "") || undefined,
      level: String(form.get("level") ?? "") || undefined,
      silenced: String(form.get("silenced") ?? "") || undefined,
      limit: "50"
    })
    const list = document.querySelector<HTMLElement>("#event-list")!
    list.innerHTML = filtered.events.length
      ? filtered.events.map(eventMarkup).join("")
      : empty("Nothing matched", "Try a different project or level filter.")
    attachEventActions(list)
    document.querySelector<HTMLButtonElement>("#load-more")?.remove()
  })

  document.querySelector<HTMLButtonElement>("#load-more")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    try {
      const next = await api.events({ before: button.dataset.cursor, limit: "50" })
      const list = document.querySelector<HTMLElement>("#event-list")!
      list.insertAdjacentHTML("beforeend", next.events.map(eventMarkup).join(""))
      attachEventActions(list)
      if (next.next_cursor) {
        button.dataset.cursor = next.next_cursor
        button.disabled = false
      } else {
        button.remove()
      }
    } catch (cause) {
      notify(errorMessage(cause))
      button.disabled = false
    }
  })

  const requested = new URL(location.href).searchParams.get("event")
  if (requested) document.querySelector(`#event-${CSS.escape(requested)}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
}

const projectCard = (project: Project): string => `
  <article class="card" data-project-card="${escapeHtml(project.id)}">
    <div class="card-head">
      <div><h2>${escapeHtml(project.icon || "📦")} ${escapeHtml(project.name)}</h2><p>${escapeHtml(project.slug)}</p></div>
      <span class="badge ${project.notify ? "success" : "silenced"}">${project.notify ? "push on" : "push off"}</span>
    </div>
    <div class="form-grid">
      <label>Minimum push level
        <select data-project-level="${escapeHtml(project.id)}">
          ${["info", "success", "warning", "error", "critical"].map((level) => `<option ${project.min_level === level ? "selected" : ""}>${level}</option>`).join("")}
        </select>
      </label>
      <label>Notifications
        <select data-project-notify="${escapeHtml(project.id)}">
          <option value="true" ${project.notify ? "selected" : ""}>Enabled</option>
          <option value="false" ${!project.notify ? "selected" : ""}>Disabled</option>
        </select>
      </label>
    </div>
    <div class="card-actions">
      <button class="button small secondary" data-project-action="test" data-project-id="${escapeHtml(project.id)}">Send test</button>
      <button class="button small ghost" data-project-action="rename" data-project-id="${escapeHtml(project.id)}" data-project-name="${escapeHtml(project.name)}">Rename</button>
      <button class="button small ghost" data-project-action="rotate" data-project-id="${escapeHtml(project.id)}">Rotate key</button>
      <button class="button small danger" data-project-action="delete" data-project-id="${escapeHtml(project.id)}">Delete</button>
    </div>
  </article>`

const renderProjects = async (): Promise<void> => {
  loading()
  const { projects } = await api.projects()
  app.innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><p>Each sender gets a narrow API key that can only create events.</p></div></div>
    <section class="panel">
      <form id="create-project" class="form-row">
        <label>Project name <input name="name" maxlength="120" placeholder="Production API" required /></label>
        <label>Icon <input name="icon" maxlength="8" placeholder="🚀" /></label>
        <button class="button primary" type="submit">Create project</button>
      </form>
    </section>
    <section class="panel"><div class="card-list">${projects.length ? projects.map(projectCard).join("") : empty("No projects", "Create the first project above.")}</div></section>`

  document.querySelector<HTMLFormElement>("#create-project")?.addEventListener("submit", async (event) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget as HTMLFormElement)
    try {
      const project = await api.createProject({ name: String(data.get("name") ?? ""), icon: String(data.get("icon") ?? "") })
      showKey(project.api_key)
      await renderProjects()
    } catch (cause) {
      notify(errorMessage(cause))
    }
  })

  for (const select of document.querySelectorAll<HTMLSelectElement>("[data-project-level]")) {
    select.addEventListener("change", async () => {
      await api.updateProject(select.dataset.projectLevel!, { min_level: select.value as Level })
      notify("Minimum notification level updated")
    })
  }
  for (const select of document.querySelectorAll<HTMLSelectElement>("[data-project-notify]")) {
    select.addEventListener("change", async () => {
      await api.updateProject(select.dataset.projectNotify!, { notify: select.value === "true" })
      notify("Project notification setting updated")
      await renderProjects()
    })
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-project-action]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.projectId!
      button.disabled = true
      try {
        switch (button.dataset.projectAction) {
          case "test":
            await api.test(id)
            notify("Test event queued")
            break
          case "rename": {
            const name = window.prompt("Project name", button.dataset.projectName)
            if (name) await api.updateProject(id, { name })
            await renderProjects()
            break
          }
          case "rotate":
            if (window.confirm("Rotate this key? The previous key stops working immediately.")) {
              const project = await api.rotateProjectKey(id)
              showKey(project.api_key)
            }
            break
          case "delete":
            if (window.confirm("Delete this project and all of its events?")) {
              await api.deleteProject(id)
              await renderProjects()
            }
            break
        }
      } catch (cause) {
        notify(errorMessage(cause))
      } finally {
        button.disabled = false
      }
    })
  }
}

const urlBase64ToBytes = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const isStandalone = (): boolean =>
  window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)

const defaultDeviceName = (): string => {
  const modernNavigator = navigator as Navigator & { readonly userAgentData?: { readonly platform?: string } }
  const platform = modernNavigator.userAgentData?.platform || navigator.platform || "Device"
  return `${platform} PWA`
}

const enablePush = async (): Promise<void> => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("This browser does not support Web Push")
  }
  if (/iPhone|iPad|iPod/u.test(navigator.userAgent) && !isStandalone()) {
    throw new Error("On iPhone or iPad, install this PWA to the Home Screen before enabling push")
  }

  const registration = await navigator.serviceWorker.ready
  const { public_key } = await api.publicKey()
  const permission = await Notification.requestPermission()
  if (permission !== "granted") throw new Error("Notification permission was not granted")

  const existing = await registration.pushManager.getSubscription()
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(public_key)
  })
  await api.registerPush(defaultDeviceName(), subscription.toJSON())
  notify("Push notifications enabled")
  pushButton.textContent = "Push enabled"
}

const pushCard = (device: PushDevice): string => `
  <article class="card">
    <div class="card-head">
      <div><h2>${escapeHtml(device.name)}</h2><p>${escapeHtml(device.endpoint_host)}</p></div>
      <span class="badge ${device.enabled ? "success" : "silenced"}">${device.enabled ? "enabled" : "disabled"}</span>
    </div>
    <p class="muted">${escapeHtml(device.user_agent || "Unknown browser")}</p>
    <div class="card-actions">
      <button class="button small ghost" data-push-action="rename" data-push-id="${escapeHtml(device.id)}" data-push-name="${escapeHtml(device.name)}">Rename</button>
      <button class="button small secondary" data-push-action="toggle" data-push-id="${escapeHtml(device.id)}" data-push-enabled="${device.enabled}">${device.enabled ? "Disable" : "Enable"}</button>
      <button class="button small danger" data-push-action="delete" data-push-id="${escapeHtml(device.id)}">Remove</button>
    </div>
  </article>`

const renderPush = async (): Promise<void> => {
  loading()
  const { subscriptions } = await api.pushDevices()
  const iphone = /iPhone|iPad|iPod/u.test(navigator.userAgent)
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Push devices</h1><p>Every installed browser subscription can receive encrypted Web Push notifications.</p></div>
      <div class="page-actions"><button id="enable-push-view" class="button primary">Enable this device</button></div>
    </div>
    ${iphone && !isStandalone() ? '<div class="callout warning">On iOS, open Share → Add to Home Screen, launch Ops Context from the icon, then enable push.</div>' : ""}
    <section class="panel">
      <div class="card-list">${subscriptions.length ? subscriptions.map(pushCard).join("") : empty("No push devices", "Install the PWA and enable notifications on this device.")}</div>
    </section>`

  document.querySelector<HTMLButtonElement>("#enable-push-view")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    try {
      await enablePush()
      await renderPush()
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      button.disabled = false
    }
  })

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-push-action]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.pushId!
      try {
        if (button.dataset.pushAction === "rename") {
          const name = window.prompt("Device name", button.dataset.pushName)
          if (name) await api.updatePush(id, { name })
        } else if (button.dataset.pushAction === "toggle") {
          await api.updatePush(id, { enabled: button.dataset.pushEnabled !== "true" })
        } else if (button.dataset.pushAction === "delete" && window.confirm("Remove this push subscription?")) {
          await api.deletePush(id)
        }
        await renderPush()
      } catch (cause) {
        notify(errorMessage(cause))
      }
    })
  }
}

const silenceCard = (silence: Silence): string => `
  <article class="card">
    <div class="card-head">
      <div><h2>${escapeHtml(silence.field)} = ${escapeHtml(silence.value)}</h2><p>${escapeHtml(silence.project_name || "All projects")}</p></div>
      <button class="button small danger" data-delete-silence="${escapeHtml(silence.id)}">Delete</button>
    </div>
    ${silence.note ? `<p>${escapeHtml(silence.note)}</p>` : ""}
  </article>`

const renderSilences = async (): Promise<void> => {
  loading()
  const [{ silences, silenced_events }, { projects }] = await Promise.all([api.silences(), api.projects()])
  app.innerHTML = `
    <div class="page-head"><div><h1>Silences</h1><p>Stop matching events from creating push notifications. ${silenced_events} stored event${silenced_events === 1 ? " is" : "s are"} currently marked as silenced.</p></div></div>
    <section class="panel">
      <form id="create-silence" class="form-grid">
        <label>Project
          <select name="project_id"><option value="">All projects</option>${projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}</select>
        </label>
        <label>Field
          <select name="field"><option>fingerprint</option><option>source</option><option>title</option></select>
        </label>
        <label>Exact value <input name="value" maxlength="500" required /></label>
        <label>Note <input name="note" maxlength="1000" /></label>
        <button class="button primary" type="submit">Create silence</button>
      </form>
    </section>
    <section class="panel"><div class="card-list">${silences.length ? silences.map(silenceCard).join("") : empty("No silence rules", "All eligible events can currently create push notifications.")}</div></section>`

  document.querySelector<HTMLFormElement>("#create-silence")?.addEventListener("submit", async (event) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget as HTMLFormElement)
    try {
      const projectId = String(data.get("project_id") ?? "")
      await api.createSilence({
        ...(projectId ? { project_id: projectId } : {}),
        field: String(data.get("field")) as Silence["field"],
        value: String(data.get("value") ?? ""),
        note: String(data.get("note") ?? "")
      })
      notify("Silence rule created")
      await renderSilences()
    } catch (cause) {
      notify(errorMessage(cause))
    }
  })

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-delete-silence]")) {
    button.addEventListener("click", async () => {
      if (!window.confirm("Delete this silence rule? Existing events remain marked as silenced.")) return
      await api.deleteSilence(button.dataset.deleteSilence!)
      await renderSilences()
    })
  }
}

const renderSettings = async (): Promise<void> => {
  loading()
  const [settings, status] = await Promise.all([api.settings(), api.status()])
  app.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Retention, redaction, and deployment status.</p></div></div>
    <div class="stats">
      <div class="stat"><span>Projects</span><strong>${status.projects}</strong></div>
      <div class="stat"><span>Events</span><strong>${status.events}</strong></div>
      <div class="stat"><span>Push devices</span><strong>${status.enabled_subscriptions}/${status.subscriptions}</strong></div>
      <div class="stat"><span>Version</span><strong>${escapeHtml(status.version)}</strong></div>
    </div>
    <section class="panel">
      <form id="settings-form" class="form-grid">
        <label>Retention days
          <input name="retention_days" type="number" min="0" max="3650" value="${settings.retention_days}" />
          <small class="muted">Use 0 to keep events forever.</small>
        </label>
        <label>Additional sensitive keys
          <textarea name="redact_keys" placeholder="One key per line">${escapeHtml(settings.redact_keys.join("\n"))}</textarea>
          <small class="muted">Defaults already include password, tokens, cookies, API keys, and card fields.</small>
        </label>
        <button class="button primary" type="submit">Save settings</button>
      </form>
    </section>
    <section class="panel">
      <div class="card-list">
        <div class="card"><h3>Runtime</h3><p>${escapeHtml(status.server)}</p></div>
        <div class="card"><h3>Database</h3><p>${escapeHtml(status.database)}</p></div>
        <div class="card"><h3>Web Push</h3><p>${status.web_push.configured ? "Configured" : "Missing VAPID configuration"} · ${escapeHtml(status.web_push.subject)}</p></div>
        <div class="card"><h3>Base URL</h3><p>${escapeHtml(status.base_url)}</p></div>
      </div>
    </section>`

  document.querySelector<HTMLFormElement>("#settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget as HTMLFormElement)
    try {
      await api.updateSettings({
        retention_days: Number.parseInt(String(data.get("retention_days") ?? "90"), 10),
        redact_keys: String(data.get("redact_keys") ?? "").split("\n").map((key) => key.trim()).filter(Boolean),
        setup_completed: true
      })
      notify("Settings saved")
    } catch (cause) {
      notify(errorMessage(cause))
    }
  })
}

const renderCurrentView = async (): Promise<void> => {
  setActiveNav()
  try {
    switch (currentView) {
      case "inbox": return await renderInbox()
      case "projects": return await renderProjects()
      case "push": return await renderPush()
      case "silences": return await renderSilences()
      case "settings": return await renderSettings()
    }
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) return
    app.innerHTML = `<section class="panel"><h1>Unable to load</h1><p class="error-text">${escapeHtml(errorMessage(cause))}</p><button id="retry-view" class="button secondary">Retry</button></section>`
    document.querySelector<HTMLButtonElement>("#retry-view")?.addEventListener("click", () => void renderCurrentView())
  }
}

setUnauthorizedHandler(showLogin)

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault()
  loginError.textContent = ""
  const username = document.querySelector<HTMLInputElement>("#login-username")!.value
  const password = document.querySelector<HTMLInputElement>("#login-password")!.value
  try {
    await api.login(username, password)
    loginDialog.close()
    document.querySelector<HTMLInputElement>("#login-password")!.value = ""
    await renderCurrentView()
  } catch (cause) {
    loginError.textContent = errorMessage(cause)
  }
})

logoutButton.addEventListener("click", async () => {
  try { await api.logout() } finally { showLogin() }
})

copyKeyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(keyValue.textContent ?? "")
  notify("API key copied")
})

for (const button of document.querySelectorAll<HTMLButtonElement>(".nav [data-view]")) {
  button.addEventListener("click", () => {
    currentView = button.dataset.view as View
    history.replaceState(null, "", currentView === "inbox" ? "/" : `/?view=${currentView}`)
    void renderCurrentView()
  })
}

pushButton.addEventListener("click", async () => {
  pushButton.disabled = true
  try {
    await enablePush()
  } catch (cause) {
    notify(errorMessage(cause))
  } finally {
    pushButton.disabled = false
  }
})

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault()
  installPrompt = event as BeforeInstallPromptEvent
  installButton.classList.remove("hidden")
})

installButton.addEventListener("click", async () => {
  if (!installPrompt) return
  await installPrompt.prompt()
  await installPrompt.userChoice
  installPrompt = undefined
  installButton.classList.add("hidden")
})

const boot = async (): Promise<void> => {
  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" })
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager?.getSubscription()
    if (subscription && Notification.permission === "granted") pushButton.textContent = "Push enabled"
  }

  const view = new URL(location.href).searchParams.get("view")
  if (["inbox", "projects", "push", "silences", "settings"].includes(view ?? "")) currentView = view as View

  try {
    const me = await api.me()
    if (!me.authenticated) showLogin()
    else await renderCurrentView()
  } catch {
    showLogin()
  }
}

void boot()
