# Sentry SDK examples

These apps follow Sentry's manual setup for each framework and send test
exceptions to Flarebox.

Start Flarebox from the repository root:

```sh
pnpm dev
```

Then run either example:

```sh
cd example/nextjs
cp .env.example .env
npm install
npm run dev
```

```sh
cd example/tanstack-start
cp .env.example .env
npm install
npm run dev
```

Set the server and public DSN variables in `.env`. These examples intentionally
use a disposable test-project key in the browser to exercise the complete
documented setup; never expose a production Flarebox project key. Next.js runs at
<http://localhost:3000>; TanStack Start runs at <http://localhost:3001>.
