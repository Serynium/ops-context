# Contributing

Ops Context is early-stage. Small, focused pull requests with tests are preferred.

## Setup

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm exec wrangler d1 migrations apply ops-context --local
pnpm build:web
pnpm dev
```

## Checks

```bash
pnpm check
```

Keep the public API backward-compatible unless the change is explicitly documented as a versioned API change. Never commit credentials, VAPID private keys, `.dev.vars`, exported D1 data, or real push subscription endpoints.
