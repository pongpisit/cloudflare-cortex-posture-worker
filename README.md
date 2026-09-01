# Cloudflare Cortex XDR Noncompliance List Worker

This Worker maps Cloudflare devices to Cortex XDR endpoints and maintains a
Cloudflare Zero Trust serial-number list containing only devices whose Cortex
security content is too old.

Access and Gateway policies use that list as a block condition. Healthy devices
do not need an individual policy-time lookup, and unknown devices intentionally
fail open until a later discovery and refresh cycle.

The stale-content threshold defaults to seven days and is managed from the
operations dashboard, along with every other operational setting. The Worker
never creates or evaluates policies; it only maintains the list, which you
attach to policies as a condition.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pongpisit/cloudflare-cortex-posture-worker)

## Contents

- [Deploy to Cloudflare](#deploy-to-cloudflare)
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
- [Dashboard](#dashboard)
- [Smoke Testing](#smoke-testing)
- [Failure Model](#failure-model)
- [Reference](#reference)

## Deploy to Cloudflare

The button above clones this repository into your account, provisions the D1
database and refresh queues, applies migrations, and deploys the Worker through
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

The deployment is intentionally inert until the remaining setup is completed:

1. Update the three vars in `wrangler.jsonc`: `ACCESS_TEAM_DOMAIN`,
   `ACCESS_AUD`, and `CORTEX_BASE_URL`.
2. Set the secrets (`CORTEX_API_KEY`, `CORTEX_API_KEY_ID`,
   `CLOUDFLARE_API_TOKEN`) in the Worker or via `.dev.vars` locally.
3. Open the dashboard, select the Zero Trust list, and enable synchronization
   (see [Dashboard](#dashboard)). All remaining configuration is managed there,
   stored in D1, and applied on the next Cron run without a redeploy.
4. Follow [Custom Provider Setup](#custom-provider-setup).
5. Run the [smoke test](#smoke-testing) and the [validation](#validation)
   checklist.

The repository must be public for others to use the button.

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
2. The Worker maps an unknown device to exactly one Cortex endpoint using the
   normalized hostname. When several Cortex endpoints share that hostname, a
   matching MAC address disambiguates them.
3. Cron refreshes known Cortex endpoints in batches and replaces the Zero Trust
   serial list with mapped devices whose `last_content_update_time` is older
   than the configured content-age threshold.

Cortex documents `last_content_update_time` as a response field, not a supported
`get_endpoint` filter. The Worker must therefore refresh known endpoint IDs in
batches of 100, but only the much smaller noncompliant serial set is published
to Cloudflare policy.

### Endpoint identity over time

`endpoint_id` is Cortex's stable key: hostnames are not unique, so refreshes
are keyed by ID. Mappings stay correct as the fleet changes:

- Every `/check` re-verifies each stored mapping against current inventory.
  Hostname or serial-number changes invalidate the mapping, write a removal
  tombstone for the old serial, and trigger re-discovery.
- An endpoint that no longer exists in Cortex fails open: its snapshot is
  cleared so the device stays allowed, and it is retried on later cycles.
- Once per hour the Worker re-runs hostname discovery for mappings whose
  endpoint disappeared. When the Cortex agent was reinstalled on the same
  machine (new `endpoint_id`, same hostname — for example after a re-image),
  the mapping is re-pointed to the current endpoint and the snapshot is
  restored. Decommissioned machines simply keep failing open at a bounded
  hourly retry cost.
- Renamed machines are handled by the `/check` identity check: the new
  hostname fails the stored-mapping comparison and re-discovery finds the
  endpoint under its new name.

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

### Cold start

There is no bulk import of Cortex endpoint IDs. The Worker learns them
organically: devices appear in `/check` inventory, are matched to Cortex
endpoints by hostname (MAC tiebreak for duplicates), and receive a snapshot in
the same discovery pass. A device that appears in a poll is therefore
denylist-eligible within one Cron cycle (about five minutes). At 10-minute
provider polling, a 12,000-device fleet is fully learned within the first one
or two polls. Endpoints that never enroll in Cloudflare are never learned —
correct, because the denylist only affects devices Cloudflare can evaluate.

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
| `mac_address[]` | MAC disambiguation for duplicate hostnames |
| `last_content_update_time` | Sole noncompliance condition |

### Test the Cortex API

Verify the credentials and see exactly what the Worker sees, before deploying:

```bash
CORTEX_BASE_URL="https://<tenant-api-fqdn>" \
CORTEX_API_KEY="<api-key>" \
CORTEX_API_KEY_ID="<key-id>" \
npm run cortex-test [hostname]
```

The script calls `POST /public_api/v1/endpoints/get_endpoint` with the same
advanced-key signature the Worker sends (`x-xdr-auth-id`, `x-xdr-nonce`,
`x-xdr-timestamp`, and the SHA-256 authorization digest), then prints each
endpoint's `last_content_update_time`, its age, and whether it would be denied.
Pass a hostname to filter to one device, or run it without arguments to sample
five recently seen endpoints. Set `CORTEX_KEY_TYPE=standard` for tenants that
issue standard security keys.

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

Update `wrangler.jsonc` with the three remaining values:

```jsonc
"ACCESS_TEAM_DOMAIN": "https://<team-name>.cloudflareaccess.com",
"ACCESS_AUD": "<bridge-application-aud>",
"CORTEX_BASE_URL": "https://<tenant-api-fqdn>"
```

Everything else is operational configuration managed from the
[dashboard](#dashboard) and stored in D1: the Zero Trust list selection, the
content-age threshold, the list capacity, and the synchronization switch. They
use safe defaults, take effect on the next Cron run, and never require a
redeploy.

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

`npm run deploy` applies pending D1 migrations before uploading the Worker.
Wrangler resolves the target account from your `wrangler login` session; pass
`--account-id` if your login has access to multiple accounts.

The first Cron run self-provisions the D1 schema, so the Worker recovers on a
fresh database even if migrations have not been applied yet.

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

The sentinel cannot match a real managed device and permits a reliable
non-empty API replacement when no devices are stale. Cloudflare does not
document whether an empty `items` array clears a Zero Trust list.

Then select it from the dashboard:

1. Open `/dashboard` and select **Load lists**. The Worker uses the configured
   `CLOUDFLARE_API_TOKEN` to list every account and `SERIAL` list the token can
   see, so you pick the target from a dropdown instead of pasting a UUID.
2. Choose the account and the list, set the content-age threshold and capacity,
   and save the configuration.
3. Enable synchronization once validation is complete. It stays off until you
   turn it on.

Every Cron cycle applies decisions from recently refreshed snapshots
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

1. Leave list synchronization disabled in the dashboard initially.
2. Confirm `/check` discovers pilot devices and D1 stores verified hostname/MAC
   mappings with serial numbers.
3. Confirm endpoint snapshots contain normalized content-update timestamps.
4. Compare the expected stale serial query with Cortex for pilot devices.
5. Enable synchronization in the dashboard without attaching Block policies.
6. Confirm stale serials are added and recovered serials are removed.
7. Test capacity protection and a deliberately invalid API token; the previous
   list must remain unchanged.
8. Attach the Block policy to a pilot application or destination.
9. Test healthy, stale, unknown, missing-serial, and ambiguous devices.
10. Expand enforcement after reviewing Access, Gateway, posture, and Worker
    logs.

The current Cron interval is five minutes. Removal of a recovered device
requires one recovery refresh (30 minutes at defaults), the following
list-sync cycle, and Gateway's posture cache — plan for roughly one hour.
Detecting a newly stale device additionally requires the detection sweep, so
plan for up to the detection interval (4 hours at defaults) plus the above;
both are negligible against the 7-day staleness threshold, and both intervals
are tunable. Existing Gateway sessions are not necessarily terminated when
posture changes.

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

The Worker refuses to update when the desired count exceeds the configured list
capacity and warns at 80% capacity.

Cortex refreshes use two tiers. Endpoints whose last-known content is stale —
the current denylist members — are re-checked at the recovery interval
(`RECOVERY_REFRESH_MINUTES`, default 30) so recovered devices are unblocked
promptly. Everything else is swept only at the detection interval
(`DETECTION_REFRESH_MINUTES`, default 240), because detecting a device that
crossed the content-age threshold is just as correct hours later. This keeps
D1 write volume proportional to the noncompliant population rather than the
fleet: at 12,000 devices with 1–5% stale, roughly 9 million writes per month,
which fits comfortably inside the paid plan's included 50 million.

D1 write volume also stays proportional to fleet churn rather than fleet size:
each provider poll only writes observation rows for devices that need action
(discovery, serial updates, invalidation) instead of the full inventory, and
the debug log is pruned to the most recent 200 entries.

## Dashboard

`GET /dashboard` serves an operations page behind the same Access application
as `/check`. It shows integration health, device counts, the current
noncompliant serial count, and a filterable device table (hostname, serial,
MAC, score, reason, content age, refresh recency). The page refreshes every 60
seconds.

The configuration panel manages all operational settings, stored in D1 and
applied on the next Cron run without a redeploy:

- **Load lists** uses the configured `CLOUDFLARE_API_TOKEN` to list the accounts
  and `SERIAL` lists the token can see, so you pick the target list from a
  dropdown instead of pasting a UUID.
- **Content age threshold** and **list capacity** set the stale boundary and
  the capacity safety limit (Zero Trust lists support 1,000 entries on Standard
  and 5,000 on Enterprise).
- **Enable list synchronization** is the master switch for list updates. It
  stays disabled until you turn it on.
- **Sync now** runs the list synchronization immediately instead of waiting
  for the next Cron cycle.

Each device row has a **Check** button that refreshes that single device from
Cortex on demand and updates the row with the result. Rows also have
checkboxes (with select-all) — **Check selected** refreshes up to 100 devices
in a single Cortex request, and **Delete selected** removes devices from
tracking. The **search bar** filters devices by hostname, serial, or MAC
address.

Deleting a device removes its mapping and observations, tombstones its serial
so the next synchronization removes it from the denylist, and deletes the
endpoint snapshot when no other mapping references it. Devices that are still
enrolled and reported by the provider are re-discovered on a later poll.

The **Debug log** button opens a chat-style popup that streams the most recent
Cortex requests and responses live — requests appear as outgoing bubbles,
responses as incoming ones, with method, URL, status, duration, headers
(authorization redacted), and bodies behind a click. It is controlled by the
**Log Cortex traffic** setting and retains the last 200 entries in D1.

JSON backing endpoints:

| Endpoint | Description |
| --- | --- |
| `GET /api/overview` | Integration statuses, device counts, noncompliant serial count, sync state |
| `GET /api/devices?status=all\|noncompliant\|compliant&search=<text>&limit=N` | Per-device compliance rows with optional search, `limit` 1–500, default 200 |
| `POST /api/devices/refresh` | Refresh devices from Cortex immediately: `{"deviceId": "..."}` or `{"deviceIds": [...]}` up to 100 |
| `POST /api/devices/delete` | Delete devices from tracking: `{"deviceId": "..."}` or `{"deviceIds": [...]}` up to 100 |
| `POST /api/sync` | Run the list synchronization immediately |
| `GET /api/debug-log?limit=N` | Recent Cortex request/response pairs, `limit` 1–200, default 50 |
| `DELETE /api/debug-log` | Clear the debug log |
| `GET /api/settings` | Current operational settings and readiness flags |
| `PUT /api/settings` | Update settings: `cloudflareAccountId`, `serialListId`, `serialListName`, `listSyncEnabled`, `maxContentAgeDays` (1–365), `listMaxItems` (1–100000), `debugLogEnabled` |
| `GET /api/cloudflare/lists` | Accounts and `SERIAL` lists visible to the API token |

Settings can also be updated directly:

```bash
curl -X PUT "https://cortex-posture.example.com/api/settings" \
  -H "CF-Access-Client-Id: <service-token-client-id>" \
  -H "CF-Access-Client-Secret: <service-token-client-secret>" \
  -H "content-type: application/json" \
  -d '{"serialListId": "<list-id>", "listSyncEnabled": true}'
```

For scripted deployments before Access is configured, set a
`BOOTSTRAP_SETTINGS` secret to a JSON object. The next Cron run applies any
unset settings (existing dashboard values are never overwritten), after which
the secret can be deleted:

```bash
echo '{"cloudflare_account_id":"<account-id>","serial_list_id":"<list-id>","list_sync_enabled":"true"}' |
  npx wrangler secret put BOOTSTRAP_SETTINGS
```

The service-token Access policy alone does not render a login page. To open the
dashboard in a browser, add an Include rule to the Worker Access application
for your administrator emails (or Identity Provider group) alongside the
existing service-token rule. Do not remove the service-token rule, and keep the
serial-denylist Block policy away from this application.

## Smoke Testing

`npm run smoke` curls every Access-protected endpoint with the custom
provider's service token and reports the HTTP status of each:

```bash
BASE_URL="https://cortex-posture.example.com" \
CF_ACCESS_CLIENT_ID="<service-token-client-id>" \
CF_ACCESS_CLIENT_SECRET="<service-token-client-secret>" \
npm run smoke
```

A single equivalent request:

```bash
curl -s "https://cortex-posture.example.com/api/overview" \
  -H "CF-Access-Client-Id: <service-token-client-id>" \
  -H "CF-Access-Client-Secret: <service-token-client-secret>"
```

Cloudflare Access exchanges the service-token headers for a
`CF-Access-Jwt-Assertion` header at the edge, which is the only credential the
Worker itself accepts. The script also verifies that requests without Access
credentials are rejected, and that invalid query parameters fail with `400`
rather than being ignored.

## Long-Term Operation

The system is designed to run unattended for years. What ages, and how it is
handled:

- **Credential expiry is the main silent risk.** Cloudflare service tokens
  default to one year; API tokens and Cortex keys have their own lifetimes.
  When a credential dies, the dashboard shows it: the Provider pill goes
  degraded when `/check` polls stop, and the Cortex and serial-list pills go
  degraded when their APIs fail. Rotate the three secrets, recreate the
  service provider integration, and verify all pills return healthy. Check
  expiry dates at least twice a year.
- **Departed devices are cleaned up automatically.** Each `/check` poll
  touches a `last_seen_at` value per device (at most one write per device
  per day), and a daily job deletes mappings unseen for
  `STALE_DEVICE_DAYS` (default 30), tombstoning their serials so the
  denylist is cleaned on the next sync. The job only runs while the provider
  is actively polling, so a dead integration can never wipe the table.
- **Malformed queue messages are dropped, not retried**, so poison messages
  cannot fill the dead-letter queue. Inspect genuine repeated failures with
  `npx wrangler queues consumer list` and the dashboard's debug log.
- **The Worker self-provisions its schema** and re-points mappings when the
  Cortex agent is reinstalled (see Endpoint identity over time), so re-imaged
  fleets require no manual reconciliation.
- **Monitoring:** point an external uptime monitor at `GET /health` and review
  the dashboard periodically. All state lives in D1 and every operational
  decision is visible as a structured log event.
- **Dependencies are minimal** (`jose` for JWT validation). Run `npm audit`
  and `npm run check` during any routine maintenance window; `npx wrangler
  rollback` restores the previous Worker version if a deploy misbehaves.

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

Cortex mapping uses the normalized hostname even though policy enforcement
uses the hardware serial. When several Cortex endpoints share a hostname, a
matching MAC address is required to disambiguate; collisions the MAC cannot
resolve remain unmapped.

## Reference

| Variable | Purpose |
| --- | --- |
| `AUTH_MODE` | `none` serves all endpoints without authentication during initial setup; the default (`access`) enforces Cloudflare Access |
| `ACCESS_TEAM_DOMAIN` | Expected Access JWT issuer for the Worker's own API |
| `ACCESS_AUD` | Bridge Access application audience |
| `CORTEX_BASE_URL` | Cortex API HTTPS origin |

While `AUTH_MODE=none`, every endpoint — including `/check` — is unauthenticated.
Use it only before the Access application exists, then switch back to `access`
when `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are configured. The dashboard shows
an `AUTH DISABLED` indicator while it is active.

Secrets:

- `CORTEX_API_KEY`
- `CORTEX_API_KEY_ID`
- `CLOUDFLARE_API_TOKEN` (account-scoped Zero Trust Write; also powers the
  dashboard list selector)

Dashboard-managed settings (stored in D1, with defaults):

| Setting | Default | Purpose |
| --- | --- | --- |
| Cloudflare account | unset | Account that owns the managed list |
| Serial list | unset | Zero Trust SERIAL list to manage |
| Content age threshold | `7` days | Stale-content boundary; use `14` for two weeks |
| List capacity | `1000` | Safety limit; `5000` on Enterprise entitlements |
| List synchronization | disabled | Master switch for list updates |
| Cortex traffic logging | enabled | Store recent Cortex request/response pairs for the debug panel |

Advanced overrides (set as Worker dashboard variables only when needed):
`RECOVERY_REFRESH_MINUTES` (`30`), `DETECTION_REFRESH_MINUTES` (`240`),
`STALE_DEVICE_DAYS` (`30`), `CORTEX_TIMEOUT_MS` (`15000`),
`CORTEX_KEY_TYPE` (`advanced`).

Official documentation:

- [Cloudflare Zero Trust lists](https://developers.cloudflare.com/cloudflare-one/reusable-components/lists/)
- [Cloudflare device serial numbers](https://developers.cloudflare.com/cloudflare-one/reusable-components/posture-checks/client-checks/corp-device/)
- [Cloudflare custom device posture integration](https://developers.cloudflare.com/cloudflare-one/integrations/service-providers/custom/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Cloudflare Gateway Network policies](https://developers.cloudflare.com/cloudflare-one/traffic-policies/network-policies/)
- [Cloudflare Zero Trust Lists API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/gateway/subresources/lists/)
- [Cortex XDR API key setup](https://cortex-docs.paloaltonetworks.com/xdr-5-api/create-a-new-api-key)
