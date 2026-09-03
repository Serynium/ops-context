# Error boundaries

Flarebox represents expected failures as tagged domain, application, and
infrastructure values. These values never contain HTTP status codes or
protocol-specific response objects.

- Domain modules emit resource-specific tags such as `ProjectNotFound`,
  `EventNotFound`, `InvalidEvent`, and `InvalidProjectCredential`.
- Infrastructure adapters translate D1, Queue, cryptography, and Web Push
  failures into `RepositoryUnavailable`, `QueueUnavailable`,
  `CryptographyUnavailable`, and `DeliveryTemporarilyUnavailable`.
- Application service layers capture only the dependencies each service needs
  and expose effects with no remaining environment requirement and a precise
  tagged error union.
- The HTTP API maps application errors to schema errors in
  `worker/src/api-models.ts`. MCP independently maps the same errors to safe
  tool failures in `worker/src/mcp.ts`.

The HTTP adapter preserves the existing public JSON codes: `validation_error`
for event-schema failures; `invalid` for other validation failures;
`not_found` for missing resources and invalid project ingestion keys;
`conflict` for conflicts; `push_not_configured` for missing Web Push
configuration; and redacted `internal` or `service_unavailable` responses for
infrastructure failures.

Queue delivery uses explicit outcomes (`Delivered`, `PermanentFailure`,
`AlreadyProcessed`, and `Retry`) for expected delivery decisions. Only
repository or cryptography failures escape as typed errors and are treated as
consumer defects by the Queue adapter.
