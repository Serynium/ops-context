CREATE INDEX push_jobs_terminal_updated
  ON push_jobs(updated_at, event_id, subscription_id)
  WHERE state IN ('sent', 'dead');
