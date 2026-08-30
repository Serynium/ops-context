-- Queue-first ingestion removes scheduled repair publication. Jobs from the
-- previous D1-first publisher that have no durable Queue retry are made
-- operator-visible instead of remaining stranded indefinitely.
UPDATE push_jobs
SET state = 'dead',
    lease_until = NULL,
    dead_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_error = 'terminalized during Queue-first ingestion migration; delivery was not durably queued',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state IN ('pending', 'sending');
