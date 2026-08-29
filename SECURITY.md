# Security policy

## Reporting

Please report vulnerabilities privately through GitHub's security advisory flow when it is enabled for this repository. Do not open a public issue containing credentials, subscription endpoints, exploit details, or event data.

## Deployment guidance

- Use a unique, long administrator password and generate the supplied PBKDF2 representation with `pnpm secrets`.
- Keep `ADMIN_PASSWORD_HASH` and `VAPID_PRIVATE_JWK` in Cloudflare secrets, never in `wrangler.jsonc` or Git.
- Set `OPS_BASE_URL` to the final HTTPS origin before enrolling devices. A Web Push subscription is origin-specific.
- Keep administrator routes same-origin. Do not add permissive CORS headers.
- Consider Cloudflare Access in front of the PWA for an additional identity boundary.
- Rotate project API keys immediately if one leaks.
- Treat event context as production data. Add organization-specific redaction keys before integrating applications.
- Configure Queue dead-letter monitoring and inspect repeated delivery failures.
- Review D1 retention, backup, and time-travel settings appropriate to your threat model.

## Supported versions

Until 1.0, only the latest commit on the default branch receives security fixes.
