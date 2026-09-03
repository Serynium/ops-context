import { Effect } from "effect"
import { enqueueEventForProject } from "./events.js"
import { projectNotFound, pushNotConfigured } from "./errors.js"
import {
  DeliveriesRepository,
  EventsRepository,
  ProjectsRepository,
  SystemRepository
} from "./repositories.js"
import { AppConfig } from "./services.js"
import { getSettings } from "./settings.js"

export const systemHealth = Effect.gen(function*() {
  const system = yield* SystemRepository
  yield* system.health
  return { status: "ok" }
}).pipe(Effect.withSpan("System.health"))

export const pushPublicKey = Effect.gen(function*() {
  const config = yield* AppConfig
  return config.vapidPublicKey
    ? { public_key: config.vapidPublicKey }
    : yield* Effect.fail(pushNotConfigured())
})

export const systemStatus = Effect.fn("System.status")(function*(origin: string) {
  const system = yield* SystemRepository
  const deliveries = yield* DeliveriesRepository
  const config = yield* AppConfig
  const counts = yield* system.counts
  const lastPush = yield* deliveries.latest
  const settings = yield* getSettings

  return {
    version: "0.4.0",
    server: "flarebox/effect-v4/cloudflare-workers",
    database: "Cloudflare D1 / Effect SQL",
    base_url: config.baseUrl ?? origin,
    uptime_seconds: null,
    web_push: {
      configured: Boolean(
        config.vapidPublicKey && config.vapidPrivateJwk && config.vapidSubject
      ),
      subject: config.vapidSubject
    },
    projects: counts.projects,
    events: counts.events,
    subscriptions: counts.subscriptions,
    enabled_subscriptions: counts.enabled_subscriptions,
    dead_jobs: counts.dead_jobs,
    failed_ingests: counts.failed_ingests,
    last_push: lastPush,
    retention_days: settings.retention_days,
    setup_completed: settings.setup_completed,
    admin_auth: Boolean(config.appHost && config.accessAppAudience),
    admin_auth_provider: "cloudflare-access" as const
  }
})

export const testNotification = Effect.fn("System.testNotification")(function*(
  origin: string,
  projectId?: string
) {
  const projects = yield* ProjectsRepository
  const config = yield* AppConfig
  const selected = projectId
    ? yield* projects.findById(projectId)
    : yield* projects.findFirst
  if (!selected) {
    return yield* Effect.fail(
      projectNotFound("create a project before sending a test notification")
    )
  }

  const webPushConfigured = Boolean(
    config.vapidPublicKey && config.vapidPrivateJwk && config.vapidSubject
  )
  const event = yield* enqueueEventForProject(selected, {
    title: "Flarebox is connected",
    body: "Web Push delivery is working.",
    level: "success",
    source: "flarebox",
    type: "test",
    // Test clicks must not be suppressed by incident deduplication.
    actions: [{
      label: "Open inbox",
      url: new URL("/", config.baseUrl ?? origin).href
    }],
    data: {
      test: true,
      tags: { channel: "web-push", source: "built-in-test" },
      context: {
        project: { id: selected.id, name: selected.name },
        web_push_configured: webPushConfigured
      },
      breadcrumbs: [{
        timestamp: new Date().toISOString(),
        message: "Test notification queued"
      }]
    }
  })
  return {
    event,
    web_push_configured: webPushConfigured
  }
})

export const rebuildEventGroups = Effect.gen(function*() {
  const events = yield* EventsRepository
  return { groups: yield* events.rebuildGroups }
}).pipe(Effect.withSpan("System.rebuildEventGroups"))
