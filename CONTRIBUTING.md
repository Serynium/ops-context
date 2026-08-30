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

```bash
pnpm check
```

`pnpm check` type-checks the Worker, Workers-runtime tests, and PWA; runs Vitest inside the Cloudflare Workers runtime with isolated D1 storage; builds the PWA; and performs a Wrangler dry-run bundle.

To record bundle composition while evaluating Worker deployment boundaries, run:

```bash
pnpm analyze:worker
```

The report uses Wrangler's minified production dry run and groups esbuild's byte
contributions. Its MCP figure is an attribution upper bound, not the predicted size of
a separately bundled Worker.

Keep the public API backward-compatible unless the change is explicitly documented as a versioned API change. Never commit credentials, VAPID private keys, `.dev.vars`, exported D1 data, or real push subscription endpoints.
