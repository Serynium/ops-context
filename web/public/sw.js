const CACHE = "ops-context-v1"
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"]

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
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return

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
    data: { url: "/" }
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
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client) await client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    })
  )
})

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const keyResponse = await fetch("/api/v1/push/public-key")
    if (!keyResponse.ok) return
    const { public_key: publicKey } = await keyResponse.json()
    const normalized = publicKey.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
    const binary = atob(padded)
    const applicationServerKey = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    })
    await fetch("/api/v1/push/subscriptions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-ops-context": "pwa" },
      body: JSON.stringify({ name: "PWA device", subscription: subscription.toJSON() })
    })
  })())
})
