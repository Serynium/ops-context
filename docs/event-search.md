# Event search

Ops Context uses a measured SQLite FTS5 index for event search. Exact project,
level, source, fingerprint, time, silence, ordering, and cursor constraints still
run against the normal `events` table and its indexes; FTS5 only selects matching
event IDs.

## Search syntax

Search is case-insensitive and uses the FTS5 `unicode61` tokenizer with diacritic
folding. A query is compiled into safe FTS expressions rather than accepting raw
FTS5 operators.

- `timeout` matches the complete token `timeout`.
- `time*` explicitly matches token prefixes such as `timeout`.
- `"connection timeout"` matches adjacent tokens in that order.
- `database timeout` requires both tokens, in any position.
- Arbitrary substrings are not matched: `imeou` does not match `timeout`.
- Punctuation separates tokens. Unicode words are supported, and `cafe` matches
  `café` through diacritic folding.

Quotes inside an unquoted token are escaped before FTS5 sees the query. An
unterminated phrase, a query longer than 240 characters, or a NUL character is
rejected as an invalid event query before D1 executes it.

The trigram tokenizer was evaluated to preserve the old arbitrary-substring
behavior. On the 50,000-event local fixture it used 18,862,080 bytes versus
14,483,456 bytes for the selected Unicode token/prefix index (+30.2%), before
accounting for production write amplification. Because explicit prefix search
covers the common partial-word case and the issue threshold is already cleared
by token searches, trigram's broader matches do not justify that additional
storage and write cost. Substring behavior is therefore intentionally replaced
by the documented token, phrase, and explicit-prefix semantics.

## Indexed data and redaction

The index contains title, body, source, fingerprint, and a normalized projection
of structured payload values. It does not index serialized JSON, JSON keys, or
the `[REDACTED]` marker. Event payloads pass through the normal recursive
redaction policy before the `events` insert and its search-index trigger execute,
so sensitive structured values never enter FTS5.

## Measured adoption threshold

Adopt FTS5 when either production `events.list` searches sustain a
`rows_read / rows_returned` ratio above 20:1 or p95 search latency above 100 ms,
and a representative local fixture shows at least an 80% reduction in VM steps.
Keep the existing query if search traffic is rare enough that the added storage
and write amplification outweigh those limits.

The 2026-08-31 D1 benchmark used an isolated WEUR database with 10,000 events
across 10 projects and one selective match. Five identical searches were run
against each populated schema. The temporary database contained synthetic data
only and was deleted after measurement.

| Search measure | Leading-wildcard `LIKE` | FTS5 | Effect |
| --- | ---: | ---: | ---: |
| D1 `rows_read` per query | 10,001 | 21 | -99.8% |
| `rows_read / rows_returned` | 10,001:1 | 21:1 | -99.8% |
| Median `sql_duration_ms` | 1.3452 ms | 0.1931 ms | -85.6% |
| Highest of five durations | 3.1557 ms | 1.9603 ms | -37.9% |
| `rows_written` per search | 0 | 0 | unchanged |

The write/storage fixture inserted the same 10,000 rows in one statement. The
plain table and its primary-key index wrote 20,000 D1 rows in 25.6246 ms. The
equivalent event table plus its FTS trigger wrote 30,000 rows in 100.7738 ms:
10,000 additional billable rows (+50%) and a 3.9x bulk-insert duration. The
plain dataset added 1,527,808 bytes to the benchmark database; the equivalent
base table plus FTS structures added 4,034,560 bytes (+164%). This is a
deliberately conservative prototype because it also stored join identifiers;
the shipped schema keys FTS directly by the event rowid and omits those stored
columns.

A second 50,000-event run on SQLite 3.43.2, the engine used by local Wrangler
D1, reduced full-scan steps from 49,999 to zero and VM steps from 225,000 to 410.
It measured 12,546,048 bytes of FTS structures beside a 7,548,928-byte events
table. Those SQLite values corroborate the D1 row measurements but are not
presented as billable D1 metrics.

The D1 fixture crosses the row-amplification and local VM-step thresholds
decisively. Production `rows_read`, `rows_written`, storage, request frequency,
and `db.duration_ms` must still be compared for the same traffic window through
the issue #17 telemetry. Each event insert now also writes one logical FTS row
and its internal index structures; retention and project deletion remove that
row. FTS5 therefore increases both storage and write cost, and those production
deltas remain explicit rollout checks.

The measurement is reproducible by loading the described distribution into an
isolated D1 database and comparing each statement's returned `rows_read`,
`rows_written`, `size_after`, and `timings.sql_duration_ms`. For a local proxy,
run `ANALYZE`, enable SQLite `.stats on`, compare the prior five
leading-wildcard predicates with the joined `event_search MATCH` query, and use
`dbstat` to sum `event_search_%` pages.

## Maintenance and rebuild

Migration `0007_event_search_fts.sql` backfills existing events and installs
insert, update, and delete triggers. Because triggers execute in the mutating
statement's transaction, event creation, retention deletion, and project cascade
deletion cannot commit with a stale index.

The repair/backfill script is idempotent and rebuilds from redacted event rows:

```sh
pnpm exec wrangler d1 execute ops-context --remote \
  --file scripts/rebuild-event-search.sql
```

Run it after applying all migrations. During backup workflows, note that D1
exports do not include virtual tables; recreate the FTS table through migrations
and run this rebuild after importing the ordinary tables.
