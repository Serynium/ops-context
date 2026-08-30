# PWA push-subscription renewal

Each enrolled PWA installation receives a separate renewal credential. This credential exists only so a service worker can replace that installation's Web Push endpoint after `pushsubscriptionchange`; it is not accepted for administrator APIs, event ingestion, or MCP.

## Credential lifecycle

- Administrator-authenticated enrollment returns the raw `ops_pwa_…` credential once.
- The browser stores the raw credential in the `ops-context-pwa` IndexedDB database, which is accessible to the page and its same-origin service worker.
- D1 stores only the SHA-256 credential hash and its issuance timestamp on the matching `push_subscriptions` row.
- `POST /api/v1/push/subscriptions/:id/renew` accepts the credential as a Bearer token and can update only that row. It returns a new credential after every successful endpoint replacement, invalidating replay of the old credential.
- Disabling, deleting, or permanently rejecting a subscription revokes the stored hash. Re-enrollment issues a new credential.

The renewal endpoint is intentionally outside administrator middleware so it continues to work when no interactive Cloudflare Access session exists. Configure a Cloudflare Access Bypass policy for the exact renewal path, `POST /api/v1/push/subscriptions/*/renew`, as well as the public VAPID-key path used when the browser must create a replacement subscription. Keep all other administrator paths protected. The Worker still requires possession of the installation-scoped credential and never promotes it into another authorization mechanism.

The service worker retries network errors, HTTP 429, and server errors up to three times. Authentication and other permanent client errors are not retried. If renewal still fails, it notifies open PWA clients and displays a local notification instructing the operator to re-enroll the device.

Treat IndexedDB content as sensitive browser storage. A same-origin script compromise can read the credential, although its authority remains limited to replacing one installation's endpoint. Revoking or removing that installation makes the credential unusable server-side.
