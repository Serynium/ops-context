const CACHE = "ops-context-v3"
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"]
const CREDENTIAL_DATABASE = "ops-context-pwa"
const CREDENTIAL_STORE = "credentials"
const CREDENTIAL_KEY = "push-renewal"

const openCredentialDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(CREDENTIAL_DATABASE, 1)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(CREDENTIAL_STORE)) {
      request.result.createObjectStore(CREDENTIAL_STORE)
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error("could not open push credential storage"))
})

const readRenewalCredential = async () => {
  const database = await openCredentialDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(CREDENTIAL_STORE).objectStore(CREDENTIAL_STORE).get(CREDENTIAL_KEY)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error("could not read push credential"))
    })
  } finally {
    database.close()
  }
}

const storeRenewalCredential = async (value, expectedCredential) => {
  const database = await openCredentialDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(CREDENTIAL_STORE, "readwrite")
      const store = transaction.objectStore(CREDENTIAL_STORE)
      const request = store.get(CREDENTIAL_KEY)
      request.onsuccess = () => {
        if (request.result?.credential === expectedCredential && !request.result?.revoked) {
          store.put(value, CREDENTIAL_KEY)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error("could not store push credential"))
    })
  } finally {
    database.close()
  }
}

const retryDelay = (attempt) => new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))

const renewSubscription = async (subscription) => {
  const renewal = await readRenewalCredential()
  if (!renewal || !renewal.installation_id || !renewal.credential) {
    throw new Error("this installation has no push renewal credential")
  }

  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`/api/v1/push/subscriptions/${encodeURIComponent(renewal.installation_id)}/renew`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${renewal.credential}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ subscription: subscription.toJSON() })
      })
      if (!response.ok) {
        const error = new Error(`push renewal returned HTTP ${response.status}`)
        error.retryable = response.status === 429 || response.status >= 500
        throw error
      }

      const result = await response.json()
      if (!result?.subscription?.id || !result?.renewal_credential) {
        throw new Error("push renewal returned an invalid credential response")
      }
      await storeRenewalCredential({
        ...renewal,
        installation_id: result.subscription.id,
        credential: result.renewal_credential,
        pending: false,
        revoked: false
      }, renewal.credential)
      return
    } catch (cause) {
      lastError = cause
      if (cause?.retryable === false || attempt === 2) break
      await retryDelay(attempt)
    }
  }
  throw lastError || new Error("push renewal failed")
}

const reportRenewalFailure = async () => {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  for (const client of windows) client.postMessage({ type: "push-renewal-failed" })
  await self.registration.showNotification("Push notifications need attention", {
    body: "Open Ops Context and enable push notifications on this device again.",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: "ops-context-push-renewal-failed",
    data: { url: "/?view=push", actionUrls: {} }
  })
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/mcp"
  ) return

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put("/", copy))
          return response
        })
        .catch(() => caches.match("/"))
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()))
      return response
    }))
  )
})

self.addEventListener("push", (event) => {
  let payload = {
    title: "Ops Context",
    body: "Something happened in one of your systems.",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { url: "/", actionUrls: {} },
    actions: []
  }

  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    if (event.data) payload.body = event.data.text()
  }

  const { title, ...options } = payload
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const actionUrls = data.actionUrls && typeof data.actionUrls === "object" ? data.actionUrls : {}
  const requested = event.action && typeof actionUrls[event.action] === "string"
    ? actionUrls[event.action]
    : data.url || "/"
  const target = new URL(requested, self.location.origin)

  event.waitUntil((async () => {
    if (target.origin !== self.location.origin) {
      return self.clients.openWindow(target.href)
    }

    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    for (const client of clients) {
      if ("focus" in client) {
        if ("navigate" in client) await client.navigate(target.href)
        return client.focus()
      }
    }
    return self.clients.openWindow(target.href)
  })())
})

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const renewalState = await readRenewalCredential()
      if (renewalState?.revoked) return
      let subscription = event.newSubscription
      if (!subscription) {
        const keyResponse = await fetch("/api/v1/push/public-key")
        if (!keyResponse.ok) throw new Error(`public key returned HTTP ${keyResponse.status}`)
        const { public_key: publicKey } = await keyResponse.json()
        const normalized = publicKey.replace(/-/g, "+").replace(/_/g, "/")
        const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
        const binary = atob(padded)
        const applicationServerKey = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey
        })
      }
      await renewSubscription(subscription)
    } catch (cause) {
      console.error("push subscription renewal failed", cause)
      await reportRenewalFailure()
    }
  })())
})
