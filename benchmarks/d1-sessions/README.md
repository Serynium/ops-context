# D1 Sessions benchmark

This disposable Worker compares an ordinary D1 binding, an unconstrained D1
session, and a `first-primary` session using the same indexed 10,000-row read.
It also verifies read-after-write within a session and after carrying its bookmark
to a new session. It must never be bound to a production database.

1. Create a temporary D1 database with its primary deliberately far from the
   caller, enable read replication, and copy `wrangler.example.jsonc` to an
   ignored temporary config with that database's name and id.
2. Set a random `BENCHMARK_TOKEN` secret on the disposable Worker, deploy it,
   call `/seed` once, then sample `/query?mode=primary`,
   `/query?mode=session`, and `/query?mode=session-latest` with the bearer token.
3. Record Worker `colo`, D1 `served_by_region`, `served_by_primary`, wall time,
   D1 duration, and rows read. Call `/consistency` to verify bookmark behavior.
4. Delete both the Worker and the D1 database immediately after the run.

The committed Workers integration test provides the non-networked regression
suite. A remote run is evidence about the particular caller/primary geometry only;
it is not a substitute for production PWA and MCP telemetry from real regions.
