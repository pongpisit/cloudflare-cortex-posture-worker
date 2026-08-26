# Deployment Guide

## 1. Cortex prerequisites

Create a least-privilege Cortex XDR API key with endpoint read access. Record:

- Tenant API FQDN
- API key ID
- API key
- Key type: standard or advanced

The Worker calls:

```text
POST /public_api/v1/endpoints/get_endpoint
```

Confirm a tenant response contains `endpoint_id`, `endpoint_name`,
`operational_status`, `last_seen`, `last_content_update_time`, and
`mac_address` before enforcement.

For advanced authentication, the Worker generates a 64-character alphanumeric
nonce, epoch-millisecond timestamp, and lowercase SHA-256 hex digest of
`api_key + nonce + timestamp`.

## 2. Configure Wrangler

Update these non-secret values in `wrangler.jsonc`:

```jsonc
"ACCESS_TEAM_DOMAIN": "https://your-team.cloudflareaccess.com",
"ACCESS_AUD": "your-access-application-audience",
"CORTEX_BASE_URL": "https://api-your-cortex-fqdn",
"CORTEX_KEY_TYPE": "advanced",
"EXTERNAL_EVAL_AUDS": "protected-access-application-aud",
"EXTERNAL_EVAL_MAPPING_MAX_AGE_MINUTES": "30"
```

Keep `MAX_CONTENT_AGE_DAYS` at `7`, or change it deliberately. A
`MAX_LAST_SEEN_MINUTES` value of `0` disables last-seen enforcement.

## 3. Provision and deploy

Authenticate and confirm the target account:

```bash
npx wrangler login
npx wrangler whoami
```

Create D1 and Queue resources if they do not already exist:

```bash
npx wrangler d1 create cortex-posture
npx wrangler queues create cortex-posture-refresh
npx wrangler queues create cortex-posture-refresh-dlq
```

Put the returned D1 database ID in `wrangler.jsonc`, then apply migrations:

```bash
npx wrangler d1 migrations apply cortex-posture --remote
```

Store secrets interactively:

```bash
npx wrangler secret put CORTEX_API_KEY
npx wrangler secret put CORTEX_API_KEY_ID
npm run key:external-evaluation | npx wrangler secret put EXTERNAL_EVAL_PRIVATE_JWK
```

Deploy the public posture Worker and route-less Gateway Worker:

```bash
npm run check
npm run deploy
```

## 4. Protect the Worker with Access

Use a custom domain for production, then create a Cloudflare Access
self-hosted application covering the Worker hostname and paths.

Create a service token and add this application policy:

| Setting | Value |
| --- | --- |
| Action | Service Auth |
| Include selector | Service Token |
| Value | Cortex posture service token |

Copy the application AUD into `ACCESS_AUD` and redeploy. The Worker validates
the `Cf-Access-Jwt-Assertion` header in addition to Access enforcing the policy.

## 5. Configure custom device posture

In Zero Trust, go to **Integrations > Service providers**, add a custom service
provider, and configure:

| Setting | Recommended value |
| --- | --- |
| REST API URL | `https://your-hostname.example/check` |
| Access client ID | Service token client ID |
| Access client secret | Service token client secret |
| Polling frequency | 10 minutes |

Under **Reusable components > Posture checks > Service provider checks**, add a
check requiring score `>= 100`.

Set posture expiration through the API to at least twice the polling interval.
Thirty to sixty minutes is a reasonable pilot value.

## 6. Apply policy safely

For Access External Evaluation, configure:

| Setting | Value |
| --- | --- |
| Evaluate URL | `https://<workers-dev-host>/external-evaluation` |
| Keys URL | `https://<workers-dev-host>/external-evaluation/keys` |

The protected application's AUD must be present in `EXTERNAL_EVAL_AUDS`.
The mapping-age limit should remain longer than the custom provider polling
interval; stale mappings fail closed.

For a Gateway Network Custom Function, use:

| Setting | Value |
| --- | --- |
| Key | `cortex_score` |
| Type | Number |
| Default value | `0` |
| Worker name | `cloudflare-cortex-posture-gateway` |

Reference it as `custom.cortex_score >= 100`. Do not use a nonzero default;
Gateway uses the default when internal Worker evaluation fails.
`GATEWAY_IP_MAX_AGE_MINUTES` defaults to 30 and should remain longer than the
custom provider polling interval. Older source-IP bindings fail closed.

1. Test healthy, stale, unprotected, unknown, and duplicate-hostname devices.
2. Review device posture and Worker logs.
3. Apply the posture selector to a pilot Access or Gateway policy.
4. Confirm an emergency administrator policy exists.
5. Expand enforcement only after false-positive review.

Gateway caches posture results for an additional interval and evaluates posture
when a session begins; an existing session is not forcibly terminated merely
because a later posture refresh fails.

## Operations

View logs:

```bash
npm run tail
```

Inspect recent Worker versions or roll back:

```bash
npx wrangler versions list
npx wrangler rollback
```

The Access-protected `GET /health` endpoint reports Cortex integration health
timestamps without exposing endpoint records or credentials.
