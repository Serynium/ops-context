# Repository boundaries

Application and domain code depend on capability-specific Effect services rather than Cloudflare D1 or a generic SQL service. The dependency direction is:

```text
HTTP / Queue / scheduled adapters
              ↓
application services and use cases
              ↓
repository ports
              ↓
D1 repository adapter → Effect SQL / Cloudflare D1
```

`ProjectsRepository`, `EventsRepository`, `SubscriptionsRepository`, `SilencesRepository`, and `SettingsRepository` own aggregate persistence. `PushJobsRepository` owns the durable delivery state machine, including atomic job-state and delivery-attempt finalization. `DeliveriesRepository` owns delivery-history reads, while `SystemRepository` exposes the small health/status read model. Administrator sessions intentionally have no repository: Cloudflare Access replaced D1 sessions before these boundaries were introduced.

The D1 adapter is the only application module that contains SQL. Every selected row passes through an Effect Schema via `SqlSchema` before it can reach a use case. JSON stored in `events.payload_json`, `events.actions_json`, and the `redact_keys` setting is parsed and validated there; malformed data is a typed, sanitized repository failure rather than a partially trusted value. Write batches are not exposed generically. Event creation with push jobs, event unsilencing with push jobs, and each delivery finalization are explicit atomic repository operations.

`D1RepositoriesLive` builds all repository implementations from a narrow D1 connection shape implemented by both the authoritative binding and a request-scoped D1 session. Production currently supplies the binding; the Sessions prototype supplies a session in integration tests without changing any repository port or domain use case. See [ADR 0003](decisions/0003-retain-primary-d1-reads.md). The application Layers capture only the individual repository and infrastructure services they use, so no broad Effect context is retained or re-provided.
