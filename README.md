# Cloudflare Cortex XDR Noncompliance List Worker

This Worker maps Cloudflare devices to Cortex XDR endpoints and maintains a
Cloudflare Zero Trust serial-number list containing only devices whose Cortex
security content is too old.

Access and Gateway policies use that list as a block condition. Healthy devices
do not need an individual policy-time lookup, and unknown devices intentionally
fail open until a later discovery and refresh cycle.

The stale-content threshold is configured with `MAX_CONTENT_AGE_DAYS`. The
default is seven days; set it to `14` if the desired grace period is two weeks.
No administrative frontend is required.

## Contents

- [Architecture](#architecture)
- [Behavior](#behavior)
- [Prerequisites](#prerequisites)
- [Cortex Configuration](#cortex-configuration)
- [Cloudflare Deployment](#cloudflare-deployment)
- [Custom Provider Setup](#custom-provider-setup)
- [Serial List Setup](#serial-list-setup)
- [Policy Setup](#policy-setup)
- [Validation](#validation)
- [Operations](#operations)
- [Failure Model](#failure-model)
- [Reference](#reference)

## Architecture

```mermaid
flowchart LR
  D[Managed device<br/>Cloudflare One Client] --> CP[Custom service provider]
  CP -->|Device ID, serial, hostname, MAC| W[Worker /check]
  W -->|Unknown device| Q[Cloudflare Queue]
  C[Cron trigger] -->|Known endpoint batches| Q
  Q -->|Cortex API| X[Cortex XDR]
  X -->|Content update time, hostname, MAC| Q
  Q -->|Verified mappings and snapshots| DB[(D1)]
  C -->|Stale mapped serials| L[Zero Trust SERIAL list]
  L --> A[Access Block policy]
  L --> G[Gateway Block policy]
```

The integration has three asynchronous stages:

1. The Cloudflare custom service provider sends device inventory to `/check`.
2. The Worker maps an unknown device to exactly one Cortex endpoint using
   normalized hostname plus a matching MAC address.
3. Cron refreshes known Cortex endpoints in batches and replaces the Zero Trust
   serial list with mapped devices whose `last_content_update_time` is older
   than `MAX_CONTENT_AGE_DAYS`.

Cortex documents `last_content_update_time` as a response field, not a supported
`get_endpoint` filter. The Worker must therefore refresh known endpoint IDs in
batches of 100, but only the much smaller noncompliant serial set is published
to Cloudflare policy.

## Behavior

For an expected 12,000-device fleet with 1–5% stale endpoints, the list normally
contains approximately 120–600 serial numbers.

| Device state | List result | Policy result |
| --- | --- | --- |
| Mapped and content older than the threshold | Serial added | Blocked |
| Mapped and content becomes current | Serial removed | Allowed |
| New or unmapped device | Not added | Allowed temporarily |
| Missing hardware serial | Not added | Allowed |
| Missing content timestamp | Not added | Allowed |
| Cortex or Cloudflare API failure | Existing list preserved | Last published decision remains |

Only `last_content_update_time` determines list membership. Cortex
`operational_status` and `last_seen` do not affect the denylist.

The list is replaced as one complete set instead of applying concurrent
add/remove operations. Before writing, the Worker validates the list ID, name,
type, and configured capacity. It verifies the returned items after writing.

## Prerequisites

- Cloudflare Workers, D1, Queues, Access, Gateway, and Cloudflare One Client.
- Permission to create an Access service token and application.
- Permission to create Zero Trust lists and policies.
- A Cloudflare API token scoped to the target account with **Zero Trust Write**.
- A Cortex XDR API key with endpoint read access.
- Node.js and npm.

Serial-number posture checks support Windows, macOS, and Linux. Cloudflare
documents mobile platforms as unsupported for serial checks; use an MDM-provided
Unique Client ID design separately if mobile enforcement is required.

## Cortex Configuration

Current Cortex navigation is **Settings > Configurations > Integrations > API
Keys > New Key**.

1. Select **Advanced** security unless the tenant requires a standard key.
2. Assign the least-privilege role that can read endpoint details through
   `POST /public_api/v1/endpoints/get_endpoint`.
3. Generate and securely record the API key. Cortex does not show it again.
4. Record the API Key ID from the API Keys page.
5. Copy the API URL and use only its HTTPS origin for `CORTEX_BASE_URL`.

The Worker consumes:

| Cortex field | Use |
| --- | --- |
| `endpoint_id` | Stable mapping target |
| `endpoint_name` | Hostname verification |
| `mac_address[]` | MAC verification |
| `last_content_update_time` | Sole noncompliance condition |

## Cloudflare Deployment

### 1. Install and authenticate

```bash
npm install
npx wrangler login
npx wrangler whoami
npm run check
```

### 2. Provision resources

For a new account:

```bash
npx wrangler d1 create cortex-posture
npx wrangler queues create cortex-posture-refresh
npx wrangler queues create cortex-posture-refresh-dlq
```

Put the returned account and D1 IDs in `wrangler.jsonc`, then apply migrations:

```bash
npm run migrate:remote
```

### 3. Configure variables

Update `wrangler.jsonc`:

```jsonc
"ACCESS_TEAM_DOMAIN": "https://<team-name>.cloudflareaccess.com",
"ACCESS_AUD": "<bridge-application-aud>",
"CORTEX_BASE_URL": "https://<tenant-api-fqdn>",
"CORTEX_KEY_TYPE": "advanced",
"MAX_CONTENT_AGE_DAYS": "7",
"SNAPSHOT_REFRESH_MINUTES": "5",
"CLOUDFLARE_LIST_SYNC_ENABLED": "false",
"CLOUDFLARE_ACCOUNT_ID": "<account-id>",
"CLOUDFLARE_SERIAL_LIST_ID": "<zero-trust-list-id>",
"CLOUDFLARE_SERIAL_LIST_NAME": "Cortex noncompliant devices",
"CLOUDFLARE_LIST_MAX_ITEMS": "1000"
```

Use `MAX_CONTENT_AGE_DAYS=14` for a 14-day threshold. Keep
`CLOUDFLARE_LIST_SYNC_ENABLED=false` until the list exists, shadow validation is
complete, and the API token is installed.

Set `CLOUDFLARE_LIST_MAX_ITEMS` to the account entitlement: Zero Trust lists
currently support 1,000 entries on Standard and 5,000 on Enterprise.

### 4. Store secrets

```bash
npx wrangler secret put CORTEX_API_KEY
npx wrangler secret put CORTEX_API_KEY_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

The Cloudflare token requires account-scoped **Zero Trust Write**. Do not put it
in `wrangler.jsonc` or Git.

### 5. Deploy

```bash
npm run deploy
```

Add a production [Workers Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
such as `cortex-posture.example.com`, for the custom provider endpoint.

## Custom Provider Setup

The custom provider supplies Cloudflare serial, hostname, and MAC inventory. Its
score is retained for visibility but is not the enforcement condition.

### 1. Create a service token

1. Go to **Zero Trust > Access controls > Service credentials > Service
   Tokens**.
2. Create `Cortex posture inventory`.
3. Save the client ID and secret. The secret is displayed once.

### 2. Protect the Worker

1. Go to **Zero Trust > Access controls > Applications**.
2. Add a **Self-hosted** application for the Worker custom domain.
3. Add an Include rule for the service token.
4. Use the **Service Auth** action.
5. Copy the application AUD to `ACCESS_AUD` and redeploy.

Do not attach the noncompliant-serial policy to this bridge application. Doing
so would prevent Cloudflare from delivering the inventory needed to update the
list.

### 3. Add the provider

1. Go to **Zero Trust > Integrations > Service providers**.
2. Select **Add new > Custom service provider**.
3. Configure:

| Setting | Value |
| --- | --- |
| Name | `Cortex XDR inventory` |
| Access client ID | Service token client ID |
| Access client secret | Service token client secret |
| REST API URL | `https://cortex-posture.example.com/check` |
| Polling frequency | `10 minutes` |

4. Select **Test and save**.

## Serial List Setup

Create the list before enabling synchronization:

1. Go to **Zero Trust > Reusable components > Lists**.
2. Select **Create manual list**.
3. Set the name to `Cortex noncompliant devices`.
4. Set **List type** to **Serial numbers**.
5. Add the initial placeholder value
   `__cortex_no_noncompliant_devices__` and save.
6. Record the list ID and put it in `CLOUDFLARE_SERIAL_LIST_ID`.

The sentinel cannot match a real managed device and permits a reliable
non-empty API replacement when no devices are stale. Cloudflare does not
document whether an empty `items` array clears a Zero Trust list.

Deploy with synchronization disabled and inspect D1/logs first. When ready:

```jsonc
"CLOUDFLARE_LIST_SYNC_ENABLED": "true"
```

Redeploy. Every Cron cycle applies decisions from recently refreshed snapshots
to the current list. Content age is measured at the snapshot's successful
Cortex refresh time, so wall-clock aging during an outage cannot create a new
denial. Membership without a fresh decision is preserved, and durable removal
tombstones clear serials that are changed or invalidated. The Worker skips the
PUT when nothing changed, rechecks decisions after publication, and uses a D1
lease to prevent overlapping Cron runs from replacing the list concurrently.
Managed serial entries include `hostname=<name>; mac=<address>` descriptions so
operators can identify devices directly from the Zero Trust list.

## Policy Setup

### Access

Create a high-priority Block policy for each protected application:

| Action | Rule type | Selector | Value |
| --- | --- | --- | --- |
| Block | Include | Device Posture - Serial Number List | `Cortex noncompliant devices` |

Keep the normal identity-based Allow policy below it. Do not use the list as an
Allow condition because it represents unhealthy devices.

### Gateway

Create the policy from **Zero Trust > Traffic policies > Firewall policies**.
In the HTTP or Network policy, scope the traffic to the protected destination
and configure:

| Selector | Operator | Value | Action |
| --- | --- | --- | --- |
| Passed Device Posture Checks | in | `Cortex noncompliant devices` | Block |

Place the Block policy above broader Allow rules. Gateway requires traffic to
arrive through Cloudflare One Client with device context.

The posture selector passes when the device serial is present in the bad-device
list; the explicit `noncompliant` name avoids reversing the rule accidentally.

## Validation

1. Leave `CLOUDFLARE_LIST_SYNC_ENABLED=false` initially.
2. Confirm `/check` discovers pilot devices and D1 stores verified hostname/MAC
   mappings with serial numbers.
3. Confirm endpoint snapshots contain normalized content-update timestamps.
4. Compare the expected stale serial query with Cortex for pilot devices.
5. Enable synchronization without attaching Block policies.
6. Confirm stale serials are added and recovered serials are removed.
7. Test capacity protection and a deliberately invalid API token; the previous
   list must remain unchanged.
8. Attach the Block policy to a pilot application or destination.
9. Test healthy, stale, unknown, missing-serial, and ambiguous devices.
10. Expand enforcement after reviewing Access, Gateway, posture, and Worker
    logs.

The current Cron interval is five minutes. Because list synchronization occurs
before the next Cortex refresh fan-out, a change may require one refresh cycle,
the following list-sync cycle, and Gateway's posture cache. Plan for roughly
10–15 minutes worst-case propagation. Existing Gateway sessions are not
necessarily terminated when posture changes.

## Operations

```bash
# Local development
cp .dev.vars.example .dev.vars
npm run migrate:local
npm run dev

# Validate and deploy
npm run check
npm run deploy

# Logs and rollback
npm run tail
npx wrangler versions list
npx wrangler rollback
```

`GET /health` is Access-protected and reports Cortex and serial-list integration
timestamps. Relevant structured events include:

- `serial_denylist_synchronized`
- `serial_denylist_sync_error`
- `serial_denylist_capacity_warning`
- `device_mapping_failed`
- `scheduled_refresh`
- `cortex_refresh_error`

The Worker refuses to update when the desired count exceeds
`CLOUDFLARE_LIST_MAX_ITEMS` and warns at 80% capacity.

## Dashboard

`GET /dashboard` serves a read-only operations page behind the same Access
application as `/check`. It shows integration health, device counts, the
current noncompliant serial count, and a filterable device table (hostname,
serial, MAC, score, reason, content age, refresh recency). The page refreshes
every 60 seconds and makes no changes to data.

JSON backing endpoints:

| Endpoint | Description |
| --- | --- |
| `GET /api/overview` | Integration statuses, device counts, noncompliant serial count |
| `GET /api/devices?status=all\|noncompliant\|compliant&limit=N` | Per-device compliance rows, `limit` 1–500, default 200 |

The service-token Access policy alone does not render a login page. To open the
dashboard in a browser, add an Include rule to the Worker Access application
for your administrator emails (or Identity Provider group) alongside the
existing service-token rule. Do not remove the service-token rule, and keep the
serial-denylist Block policy away from this application.

## Failure Model

This design intentionally fails open for devices not already present in the
denylist:

- Unknown or not-yet-mapped devices are allowed.
- Devices without serial numbers are allowed.
- Missing content timestamps are allowed.
- A Cortex refresh failure leaves previous snapshots and list membership.
- A Cloudflare API failure leaves the existing list untouched.
- Capacity overflow refuses the entire update rather than publishing a partial
  list.

A stale device already in the list remains blocked during an outage. A newly
stale device is allowed until Cortex refresh and list synchronization succeed.

Hostname plus MAC is required for Cortex mapping even though policy enforcement
uses the hardware serial. Hostname-only matches are rejected, and ambiguous
matches remain unmapped.

## Reference

| Variable | Purpose |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | Expected Access JWT issuer |
| `ACCESS_AUD` | Bridge Access application audience |
| `CORTEX_BASE_URL` | Cortex API HTTPS origin |
| `CORTEX_KEY_TYPE` | `advanced` or `standard` |
| `MAX_CONTENT_AGE_DAYS` | Stale-content threshold, typically `7` or `14` |
| `CORTEX_TIMEOUT_MS` | Cortex request timeout |
| `SNAPSHOT_REFRESH_MINUTES` | Known-endpoint refresh interval |
| `CLOUDFLARE_LIST_SYNC_ENABLED` | Explicit list update switch |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the list |
| `CLOUDFLARE_SERIAL_LIST_ID` | Existing Zero Trust SERIAL list ID |
| `CLOUDFLARE_SERIAL_LIST_NAME` | Exact list name validated before writes |
| `CLOUDFLARE_LIST_MAX_ITEMS` | Safety limit matching account entitlement |

Secrets:

- `CORTEX_API_KEY`
- `CORTEX_API_KEY_ID`
- `CLOUDFLARE_API_TOKEN`

Official documentation:

- [Cloudflare Zero Trust lists](https://developers.cloudflare.com/cloudflare-one/reusable-components/lists/)
- [Cloudflare device serial numbers](https://developers.cloudflare.com/cloudflare-one/reusable-components/posture-checks/client-checks/corp-device/)
- [Cloudflare custom device posture integration](https://developers.cloudflare.com/cloudflare-one/integrations/service-providers/custom/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Cloudflare Gateway Network policies](https://developers.cloudflare.com/cloudflare-one/traffic-policies/network-policies/)
- [Cloudflare Zero Trust Lists API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/gateway/subresources/lists/)
- [Cortex XDR API key setup](https://cortex-docs.paloaltonetworks.com/xdr-5-api/create-a-new-api-key)
