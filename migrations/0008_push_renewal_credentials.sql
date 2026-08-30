-- Browser installations use this hash only for background subscription renewal.
-- The raw credential is returned once and remains in the installation's IndexedDB.
ALTER TABLE push_subscriptions ADD COLUMN renewal_credential_hash TEXT;
ALTER TABLE push_subscriptions ADD COLUMN renewal_credential_issued_at TEXT;
ALTER TABLE push_subscriptions ADD COLUMN previous_renewal_credential_hash TEXT;
ALTER TABLE push_subscriptions ADD COLUMN previous_renewal_credential_valid_until TEXT;
-- Once an installation is explicitly enrolled, a delayed silent legacy upgrade
-- must not replace the credential selected by that explicit enrollment.
ALTER TABLE push_subscriptions ADD COLUMN explicitly_enrolled INTEGER NOT NULL DEFAULT 0
  CHECK (explicitly_enrolled IN (0, 1));
-- Removed installations remain as hidden endpoint tombstones so an older browser
-- cannot silently recreate itself before an operator explicitly re-enrolls it.
ALTER TABLE push_subscriptions ADD COLUMN deleted_at TEXT;
-- Fanout snapshots this generation so removal followed by re-enrollment cannot
-- revive a notification intended for the prior enrollment.
ALTER TABLE push_subscriptions ADD COLUMN enrollment_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_jobs ADD COLUMN subscription_generation INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX push_subscriptions_renewal_credential_hash
  ON push_subscriptions(renewal_credential_hash)
  WHERE renewal_credential_hash IS NOT NULL;
