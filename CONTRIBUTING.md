# Contributing

Ops Context is early-stage. Small, focused pull requests with tests are preferred.

## Setup

```bash
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm exec wrangler d1 migrations apply ops-context --local
pnpm build:web
pnpm dev
```

Use the pnpm version declared by the repository through Corepack. When dependencies change, update and commit `pnpm-lock.yaml` in the same pull request.

## Checks

Pure unit tests run in Node and do not start the Workers runtime:

```bash
pnpm test:unit
```

Infrastructure contract tests run in Workerd through the official Cloudflare Vitest integration. They apply every real D1 migration to isolated storage and exercise Worker fetch and Queue entrypoints:

```bash
pnpm test:integration
```

Use `pnpm test:integration:watch` while iterating on the D1/Queue suite. Integration-test failures include the relevant durable job, delivery, subscription, or Queue result state in assertion output.

Run the complete repository check before opening a pull request:

```bash
pnpm check
```

`pnpm check` type-checks the Worker, Workers-runtime tests, and PWA; runs both the Node unit suite and the Workerd integration suite; builds the PWA; and performs a Wrangler dry-run bundle.

Keep the public API backward-compatible unless the change is explicitly documented as a versioned API change. Never commit credentials, VAPID private keys, `.dev.vars`, exported D1 data, or real push subscription endpoints.
