# Security

Do not commit Cortex API keys, Access service-token secrets, `.dev.vars`, or
production endpoint data. Configure Cortex credentials with Wrangler secrets.

Report vulnerabilities privately to the repository owner. Include the affected
version, reproduction steps, and impact. Do not include real endpoint records or
credentials in an issue.

The `/check` and `/health` endpoints must be protected by a Cloudflare Access
self-hosted application using a Service Auth policy. The Worker also validates
the Access JWT issuer, audience, expiry, and RS256 signature.
