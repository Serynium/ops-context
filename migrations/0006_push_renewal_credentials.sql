-- Browser installations use this hash only for background subscription renewal.
-- The raw credential is returned once and remains in the installation's IndexedDB.
ALTER TABLE push_subscriptions ADD COLUMN renewal_credential_hash TEXT;
ALTER TABLE push_subscriptions ADD COLUMN renewal_credential_issued_at TEXT;
ALTER TABLE push_subscriptions ADD COLUMN previous_renewal_credential_hash TEXT;
ALTER TABLE push_subscriptions ADD COLUMN previous_renewal_credential_valid_until TEXT;

CREATE UNIQUE INDEX push_subscriptions_renewal_credential_hash
  ON push_subscriptions(renewal_credential_hash)
  WHERE renewal_credential_hash IS NOT NULL;
