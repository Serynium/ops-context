-- Cloudflare Access is now the only administrator identity provider.
-- Existing application sessions are intentionally invalidated.
DROP TABLE IF EXISTS admin_sessions;
