import "./styles.css"
import "./v12.css"
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
import {
  beginPushEnrollment,
  completePushEnrollment,
  markPushEnrollmentRevoked,
  readPushRenewalCredential,
  revokePushRenewalCredential
} from "./push-renewal.js"

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
let groupRepeats = localStorage.getItem("ops-context-group-repeats") !== "false"
let inboxFilters: Record<string, string | undefined> = { limit: "50" }

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

const formatRelativeGroup = (event: EventItem): string => {
  if (!event.group) return ""
  return `${event.group.count} occurrence${event.group.count === 1 ? "" : "s"} · First ${formatDate(event.group.first_seen)} · Last ${formatDate(event.group.last_seen)}`
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
  `<span class="badge level-badge ${level}">${escapeHtml(level)}</span>`

const safeActionUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return ["javascript:", "data:", "file:"].includes(url.protocol.toLowerCase()) ? undefined : url.href
  } catch {
    return undefined
  }
}

const eventPlainText = (event: EventItem): string => {
  const lines = [
    event.title,
    event.body,
    `Project: ${event.project_name}`,
    `Level: ${event.level}`,
    event.source ? `Source: ${event.source}` : "",
    event.type ? `Type: ${event.type}` : "",
    event.fingerprint ? `Fingerprint: ${event.fingerprint}` : "",
    `Occurred: ${event.occurred_at}`,
    event.group ? `Occurrences: ${event.group.count} (${event.group.first_seen} — ${event.group.last_seen})` : "",
    "",
    "Context:",
    JSON.stringify(event.data, null, 2),
    event.actions.length > 0 ? "\nLinks:" : "",
    ...event.actions.map((action) => `${action.label}: ${action.url}`)
  ]
  return lines.filter((line, index) => line !== "" || index === 1 || index === 9).join("\n").trim()
}

const markdownJsonSection = (title: string, value: unknown): ReadonlyArray<string> => {
  if (value === undefined || value === null) return []
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return []
  return [`## ${title}`, "", "```json", JSON.stringify(value, null, 2), "```", ""]
}

const eventMarkdown = (event: EventItem): string => {
  const data = event.data
  const stack = data.stack_trace ?? data.stacktrace ?? data.stack
  const exception = data.exception ?? data.error
  const environment = data.environment ?? data.env
  const context = data.context
  const breadcrumbs = data.breadcrumbs
  const reserved = new Set(["stack_trace", "stacktrace", "stack", "exception", "error", "environment", "env", "context", "breadcrumbs"])
  const remaining = Object.fromEntries(Object.entries(data).filter(([key]) => !reserved.has(key)))

  const lines: Array<string> = [
    `# ${event.title}`,
    "",
    `- **Project:** ${event.project_name}`,
    `- **Level:** ${event.level}`,
    `- **Occurred:** ${event.occurred_at}`,
    ...(event.source ? [`- **Source:** ${event.source}`] : []),
    ...(event.type ? [`- **Type:** ${event.type}`] : []),
    ...(event.fingerprint ? [`- **Fingerprint:** \`${event.fingerprint}\``] : []),
    ...(event.group ? [`- **Occurrences:** ${event.group.count} (${event.group.first_seen} — ${event.group.last_seen})`] : []),
    ""
  ]

  if (event.body) lines.push("## Message", "", event.body, "")
  lines.push(...markdownJsonSection("Exception", exception))
  lines.push(...markdownJsonSection("Environment", environment))
  if (stack !== undefined && stack !== null) {
    lines.push("## Stack trace", "", "```text", typeof stack === "string" ? stack : JSON.stringify(stack, null, 2), "```", "")
  }
  lines.push(...markdownJsonSection("Context", context))
  lines.push(...markdownJsonSection("Breadcrumbs", breadcrumbs))
  lines.push(...markdownJsonSection("Data", remaining))
  if (event.actions.length > 0) {
    lines.push("## Links", "", ...event.actions.map((action) => `- [${action.label}](${action.url})`), "")
  }
  return lines.join("\n").trim()
}

const actionLinksMarkup = (event: EventItem): string => {
  const links = event.actions.flatMap((action) => {
    const url = safeActionUrl(action.url)
    return url ? [`<a class="button small primary action-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(action.label)}</a>`] : []
  })
  return links.length > 0 ? `<div class="event-link-actions">${links.join("")}</div>` : ""
}

const eventMarkup = (event: EventItem): string => {
  const usefulSilenceField = event.fingerprint
    ? ["fingerprint", event.fingerprint]
    : event.source
      ? ["source", event.source]
      : ["title", event.title]
  const group = event.group && event.group.count > 1
    ? `<div class="group-summary"><strong>×${event.group.count}</strong><span>${escapeHtml(formatRelativeGroup(event))}</span></div>`
    : ""

  return `
    <article class="event" id="event-${escapeHtml(event.id)}">
      <div class="event-head">
        <div class="event-title">
          <span class="project-icon">${escapeHtml(event.project_icon || "🔔")}</span>
          <div class="event-copy">
            <h2>${escapeHtml(event.title)}</h2>
            ${event.body ? `<p>${escapeHtml(event.body)}</p>` : ""}
          </div>
        </div>
        <div class="event-badges">${levelBadge(event.level)} ${event.silenced ? '<span class="badge silenced">silenced</span>' : ""}</div>
      </div>
      ${group}
      <div class="meta">
        <span>${escapeHtml(event.project_name)}</span>
        ${event.source ? `<span>· ${escapeHtml(event.source)}</span>` : ""}
        <span>· ${escapeHtml(formatDate(event.occurred_at))}</span>
      </div>
      ${actionLinksMarkup(event)}
      <details>
        <summary>Context</summary>
        <pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
      </details>
      <div class="event-actions event-actions-wrap">
        ${event.group && event.group.count > 1
          ? `<button class="button small secondary" data-action="open-group" data-project-id="${escapeHtml(event.project_id)}" data-fingerprint="${escapeHtml(event.fingerprint)}">View ${event.group.count} occurrences</button>`
          : ""}
        <button class="button small ghost" data-action="copy-event" data-event-id="${escapeHtml(event.id)}">Copy</button>
        <button class="button small ghost" data-action="copy-markdown" data-event-id="${escapeHtml(event.id)}">Copy as Markdown</button>
        <button class="button small ghost" data-action="share-event" data-event-id="${escapeHtml(event.id)}">Share</button>
        ${event.silenced
          ? `<button class="button small secondary" data-action="unsilence" data-event-id="${escapeHtml(event.id)}">Unsilence and push</button>`
          : `<button class="button small ghost" data-action="silence-event" data-event-id="${escapeHtml(event.id)}" data-project-id="${escapeHtml(event.project_id)}" data-field="${escapeHtml(usefulSilenceField[0])}" data-value="${escapeHtml(usefulSilenceField[1])}">Silence similar</button>`}
      </div>
    </article>`
}

const eventsById = new Map<string, EventItem>()

const rememberEvents = (events: ReadonlyArray<EventItem>): void => {
  for (const event of events) eventsById.set(event.id, event)
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

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-action='copy-event']")) {
    button.addEventListener("click", async () => {
      const event = eventsById.get(button.dataset.eventId ?? "")
      if (!event) return
      await navigator.clipboard.writeText(eventPlainText(event))
      notify("Event copied")
    })
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-action='copy-markdown']")) {
    button.addEventListener("click", async () => {
      const event = eventsById.get(button.dataset.eventId ?? "")
      if (!event) return
      await navigator.clipboard.writeText(eventMarkdown(event))
      notify("Markdown copied for your agent")
    })
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-action='share-event']")) {
    button.addEventListener("click", async () => {
      const event = eventsById.get(button.dataset.eventId ?? "")
      if (!event) return
      const text = eventMarkdown(event)
      if (navigator.share) {
        await navigator.share({ title: event.title, text, url: `${location.origin}/?event=${encodeURIComponent(event.id)}` })
      } else {
        await navigator.clipboard.writeText(text)
        notify("Sharing is unavailable, so Markdown was copied")
      }
    })
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-action='open-group']")) {
    button.addEventListener("click", () => {
      const projectId = button.dataset.projectId
      const fingerprint = button.dataset.fingerprint
      if (projectId && fingerprint) void renderEventGroup(projectId, fingerprint)
    })
  }
}

const datetimeValue = (value: string | undefined): string => value ? value.slice(0, 16) : ""

const toRfc3339 = (value: FormDataEntryValue | null): string | undefined => {
  const text = String(value ?? "").trim()
  if (!text) return undefined
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

const renderEventGroup = async (projectId: string, fingerprint: string): Promise<void> => {
  loading()
  const page = await api.eventGroup(projectId, fingerprint, {
    since: inboxFilters.since,
    until: inboxFilters.until,
    level: inboxFilters.level,
    source: inboxFilters.source,
    silenced: inboxFilters.silenced,
    limit: "100"
  })
  rememberEvents(page.events)
  const url = new URL(location.href)
  url.searchParams.set("view", "inbox")
  url.searchParams.set("project", projectId)
  url.searchParams.set("group", fingerprint)
  url.searchParams.delete("event")
  history.replaceState(null, "", `${url.pathname}?${url.searchParams}`)
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Fingerprint group</h1><p><code>${escapeHtml(fingerprint)}</code> · ${page.events.length} loaded occurrence${page.events.length === 1 ? "" : "s"}</p></div>
      <div class="page-actions"><button id="back-to-inbox" class="button secondary">Back to inbox</button></div>
    </div>
    <section class="panel">
      <div class="event-list">${page.events.length ? page.events.map(eventMarkup).join("") : empty("No occurrences", "The current filters exclude every occurrence in this group.")}</div>
    </section>`
  attachEventActions(app)
  document.querySelector<HTMLButtonElement>("#back-to-inbox")?.addEventListener("click", () => {
    history.replaceState(null, "", "/")
    void renderInbox()
  })
}

const renderInbox = async (): Promise<void> => {
  const requestedUrl = new URL(location.href)
  const requestedGroup = requestedUrl.searchParams.get("group")
  const requestedProject = requestedUrl.searchParams.get("project")
  if (requestedGroup && requestedProject) return renderEventGroup(requestedProject, requestedGroup)

  loading()
  const query = { ...inboxFilters, grouped: String(groupRepeats), limit: "50" }
  const [{ projects }, page] = await Promise.all([api.projects(), api.events(query)])
  rememberEvents(page.events)
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Inbox</h1><p>Everything your systems decided was worth knowing about.</p></div>
      <div class="page-actions">
        <label class="toggle-label"><input id="group-repeats" type="checkbox" ${groupRepeats ? "checked" : ""} /> Group repeats</label>
        <button id="refresh-inbox" class="button secondary">Refresh</button>
      </div>
    </div>
    <section class="panel">
      <form id="event-filters" class="filter-grid">
        <label>Project
          <select name="project">
            <option value="">All projects</option>
            ${projects.map((project) => `<option value="${escapeHtml(project.id)}" ${inboxFilters.project === project.id ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}
          </select>
        </label>
        <label>Level
          <select name="level">
            <option value="">All levels</option>
            ${["info", "success", "warning", "error", "critical"].map((level) => `<option value="${level}" ${inboxFilters.level === level ? "selected" : ""}>${level}</option>`).join("")}
          </select>
        </label>
        <label>Source <input name="source" value="${escapeHtml(inboxFilters.source ?? "")}" /></label>
        <label>Fingerprint <input name="fingerprint" value="${escapeHtml(inboxFilters.fingerprint ?? "")}" /></label>
        <label>Search <input name="search" value="${escapeHtml(inboxFilters.search ?? "")}" placeholder="Title, body, context…" /></label>
        <label>Visibility
          <select name="silenced">
            <option value="">All events</option>
            <option value="false" ${inboxFilters.silenced === "false" ? "selected" : ""}>Not silenced</option>
            <option value="true" ${inboxFilters.silenced === "true" ? "selected" : ""}>Silenced</option>
          </select>
        </label>
        <label>Since <input name="since" type="datetime-local" value="${escapeHtml(datetimeValue(inboxFilters.since))}" /></label>
        <label>Until <input name="until" type="datetime-local" value="${escapeHtml(datetimeValue(inboxFilters.until))}" /></label>
        <div class="filter-actions"><button class="button primary" type="submit">Apply</button><button id="clear-filters" class="button ghost" type="button">Clear</button></div>
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
  document.querySelector<HTMLInputElement>("#group-repeats")?.addEventListener("change", (event) => {
    groupRepeats = (event.currentTarget as HTMLInputElement).checked
    localStorage.setItem("ops-context-group-repeats", String(groupRepeats))
    void renderInbox()
  })
  document.querySelector<HTMLButtonElement>("#clear-filters")?.addEventListener("click", () => {
    inboxFilters = { limit: "50" }
    void renderInbox()
  })

  document.querySelector<HTMLFormElement>("#event-filters")?.addEventListener("submit", (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget as HTMLFormElement)
    const value = (key: string): string | undefined => String(form.get(key) ?? "").trim() || undefined
    inboxFilters = {
      project: value("project"),
      level: value("level"),
      source: value("source"),
      fingerprint: value("fingerprint"),
      search: value("search"),
      silenced: value("silenced"),
      since: toRfc3339(form.get("since")),
      until: toRfc3339(form.get("until")),
      limit: "50"
    }
    void renderInbox()
  })

  document.querySelector<HTMLButtonElement>("#load-more")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    try {
      const next = await api.events({
        ...inboxFilters,
        grouped: String(groupRepeats),
        before: button.dataset.cursor,
        limit: "50"
      })
      rememberEvents(next.events)
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

  const requested = requestedUrl.searchParams.get("event")
  if (requested) document.querySelector(`#event-${CSS.escape(requested)}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
}

const projectCard = (project: Project): string => `
  <article class="card compact-project" data-project-card="${escapeHtml(project.id)}">
    <div class="compact-project-main">
      <div><h2>${escapeHtml(project.icon || "📦")} ${escapeHtml(project.name)}</h2><p>${escapeHtml(project.slug)}</p></div>
      <span class="badge ${project.notify ? "success" : "silenced"}">${project.notify ? "push on" : "push off"}</span>
    </div>
    <div class="compact-project-settings">
      <label>Minimum level
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
      <div class="card-actions">
        <button class="button small secondary" data-project-action="test" data-project-id="${escapeHtml(project.id)}">Test</button>
        <button class="button small ghost" data-project-action="rename" data-project-id="${escapeHtml(project.id)}" data-project-name="${escapeHtml(project.name)}">Rename</button>
        <button class="button small ghost" data-project-action="rotate" data-project-id="${escapeHtml(project.id)}">Rotate key</button>
        <button class="button small danger" data-project-action="delete" data-project-id="${escapeHtml(project.id)}">Delete</button>
      </div>
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

const urlBase64ToBytes = (value: string): ArrayBuffer => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer as ArrayBuffer
}

const isStandalone = (): boolean =>
  window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)

const defaultDeviceName = (): string => {
  const modernNavigator = navigator as Navigator & { readonly userAgentData?: { readonly platform?: string } }
  const platform = modernNavigator.userAgentData?.platform || navigator.platform || "Device"
  return `${platform} PWA`
}

const enablePush = async (): Promise<void> => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser does not support Web Push")
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
  const enrollmentKey = await beginPushEnrollment(true)
  const enrollment = await api.registerPush(
    defaultDeviceName(),
    enrollmentKey,
    subscription.toJSON(),
    true
  )
  await completePushEnrollment(enrollmentKey, {
    installation_id: enrollment.subscription.id,
    credential: enrollment.renewal_credential
  })
  notify("Push notifications enabled")
  pushButton.textContent = "Push enabled"
}

const provisionExistingPushCredential = async (): Promise<void> => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  const current = await readPushRenewalCredential()
  if (!subscription || current?.credential || current?.revoked) return

  const enrollmentKey = await beginPushEnrollment(false)
  let enrollment
  try {
    enrollment = await api.registerPush(
      defaultDeviceName(),
      enrollmentKey,
      subscription.toJSON(),
      false
    )
  } catch (cause) {
    if (
      cause instanceof ApiError &&
      (cause.code === "subscription_disabled" || cause.code === "subscription_enrollment_superseded")
    ) {
      await markPushEnrollmentRevoked(enrollmentKey)
      return
    }
    throw cause
  }
  await completePushEnrollment(enrollmentKey, {
    installation_id: enrollment.subscription.id,
    credential: enrollment.renewal_credential
  })
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
      ${device.enabled
        ? `<button class="button small secondary" data-push-action="toggle" data-push-id="${escapeHtml(device.id)}" data-push-enabled="true">Disable</button>`
        : '<span class="muted">Re-enroll from this device</span>'}
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
    <section class="panel"><div class="card-list">${subscriptions.length ? subscriptions.map(pushCard).join("") : empty("No push devices", "Install the PWA and enable notifications on this device.")}</div></section>`

  document.querySelector<HTMLButtonElement>("#enable-push-view")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    try { await enablePush(); await renderPush() } catch (cause) { notify(errorMessage(cause)) } finally { button.disabled = false }
  })

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-push-action]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.pushId!
      try {
        if (button.dataset.pushAction === "rename") {
          const name = window.prompt("Device name", button.dataset.pushName)
          if (name) await api.updatePush(id, { name })
        } else if (button.dataset.pushAction === "toggle") {
          const enabled = button.dataset.pushEnabled !== "true"
          const localRenewal = await readPushRenewalCredential()
          await api.updatePush(id, { enabled })
          if (!enabled) await revokePushRenewalCredential(id, localRenewal?.credential)
        } else if (button.dataset.pushAction === "delete" && window.confirm("Remove this push subscription?")) {
          const localRenewal = await readPushRenewalCredential()
          await api.deletePush(id)
          await revokePushRenewalCredential(id, localRenewal?.credential)
        }
        await renderPush()
      } catch (cause) { notify(errorMessage(cause)) }
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
        <label>Project <select name="project_id"><option value="">All projects</option>${projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}</select></label>
        <label>Field <select name="field"><option>fingerprint</option><option>source</option><option>title</option></select></label>
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
    } catch (cause) { notify(errorMessage(cause)) }
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
    <div class="page-head"><div><h1>Settings</h1><p>Retention, redaction, MCP, and deployment status.</p></div></div>
    <div class="stats">
      <div class="stat"><span>Projects</span><strong>${status.projects}</strong></div>
      <div class="stat"><span>Events</span><strong>${status.events}</strong></div>
      <div class="stat"><span>Push devices</span><strong>${status.enabled_subscriptions}/${status.subscriptions}</strong></div>
      <div class="stat"><span>Dead deliveries</span><strong>${status.dead_jobs}</strong></div>
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
          <small class="muted">Defaults already include passwords, tokens, cookies, API keys, and card fields.</small>
        </label>
        <label class="setting-toggle"><input name="mcp_enabled" type="checkbox" ${settings.mcp_enabled ? "checked" : ""} /> Enable read-only MCP endpoint</label>
        <div class="callout ${settings.mcp_enabled && !settings.mcp_token_set ? "warning" : ""}">
          <strong>MCP Streamable HTTP:</strong> <code>${escapeHtml(`${status.base_url.replace(/\/$/u, "")}/mcp`)}</code><br />
          Token: ${settings.mcp_token_set ? "configured" : "not configured — run wrangler secret put OPS_MCP_TOKEN"}
        </div>
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
    const form = event.currentTarget as HTMLFormElement
    const data = new FormData(form)
    try {
      await api.updateSettings({
        retention_days: Number.parseInt(String(data.get("retention_days") ?? "90"), 10),
        redact_keys: String(data.get("redact_keys") ?? "").split("\n").map((key) => key.trim()).filter(Boolean),
        setup_completed: true,
        mcp_enabled: (form.elements.namedItem("mcp_enabled") as HTMLInputElement).checked
      })
      notify("Settings saved")
      await renderSettings()
    } catch (cause) { notify(errorMessage(cause)) }
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
  } catch (cause) { loginError.textContent = errorMessage(cause) }
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
  try { await enablePush() } catch (cause) { notify(errorMessage(cause)) } finally { pushButton.disabled = false }
})

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault()
  installPrompt = event as BeforeInstallPromptEvent
  installButton.classList.remove("hidden")
})

navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type === "push-renewal-failed") {
    notify("Push renewal failed. Open Push devices and enable this device again.")
  }
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
    const renewal = await readPushRenewalCredential()
    if (subscription && renewal?.credential && Notification.permission === "granted") {
      pushButton.textContent = "Push enabled"
    }
  }

  const view = new URL(location.href).searchParams.get("view")
  if (["inbox", "projects", "push", "silences", "settings"].includes(view ?? "")) currentView = view as View

  try {
    const me = await api.me()
    if (!me.authenticated) showLogin()
    else {
      await provisionExistingPushCredential().catch((cause) => notify(errorMessage(cause)))
      await renderCurrentView()
    }
  } catch {
    showLogin()
  }
}

void boot()
