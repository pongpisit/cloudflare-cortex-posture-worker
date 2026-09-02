# Setup guide

How to deploy and connect the Worker end to end:

1. [Deploy to Cloudflare](#deploy-to-cloudflare)
2. [Cortex configuration](#cortex-configuration)
3. [Serial list setup](#serial-list-setup)
4. [Custom provider setup](#custom-provider-setup)
5. [Securing the endpoint (optional)](#securing-the-endpoint-optional)
6. [Policy setup](#policy-setup)
7. [Validation](#validation)
8. [Smoke testing](#smoke-testing)

## Prerequisites

- Cloudflare Workers, D1, Queues, and Zero Trust (lists, custom service
  provider, and Access/Gateway policies).
- Permission to create Zero Trust lists and policies.
- A Cloudflare API token scoped to the target account with **Zero Trust Write**.
- A Cortex XDR API key with endpoint read access.
- Node.js and npm.

Serial-number posture checks support Windows, macOS, and Linux. Cloudflare
documents mobile platforms as unsupported for serial checks; use an MDM-provided
Unique Client ID design separately if mobile enforcement is required.

## Deploy to Cloudflare

The button in the [README](../README.md) clones this repository into your
account, provisions the D1 database and refresh queues, applies migrations, and
deploys the Worker through
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).
The deploy flow prompts for the Cortex base URL and the API credentials.

The deployment is intentionally inert until the remaining setup is completed:

1. Set `CORTEX_BASE_URL` and the secrets (`CORTEX_API_KEY`,
   `CORTEX_API_KEY_ID`, `CLOUDFLARE_API_TOKEN`) if the deploy flow did not
   already collect them.
2. Open the dashboard, select the Zero Trust list, and enable synchronization
   (see the [dashboard guide](dashboard.md)). All remaining configuration is
   managed there, stored in D1, and applied on the next Cron run without a
   redeploy.
3. Follow [Custom provider setup](#custom-provider-setup).
4. Run the [smoke test](#smoke-testing) and the [validation](#validation)
   checklist.

The repository must be public for others to use the button.

Manual alternative:

```bash
npm install
npx wrangler login

npx wrangler d1 create cortex-posture
npx wrangler queues create cortex-posture-refresh
npx wrangler queues create cortex-posture-refresh-dlq
```

Put the returned D1 ID in `wrangler.jsonc`, then:

```bash
npx wrangler secret put CORTEX_BASE_URL
npx wrangler secret put CORTEX_API_KEY
npx wrangler secret put CORTEX_API_KEY_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npm run migrate:remote
npm run deploy
```

The first Cron run self-provisions the D1 schema, so the Worker recovers on a
fresh database even if migrations have not been applied yet.

Add a production [Workers Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
such as `cortex-posture.example.com`, for the custom provider endpoint.

## Cortex configuration

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
| `mac_address[]` | MAC disambiguation and identity verification |
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

## Serial list setup

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

## Custom provider setup

The custom provider supplies Cloudflare device inventory (device ID, serial,
hostname, MAC). Configure it in the Cloudflare dashboard:

1. Go to **Zero Trust > Integrations > Service providers**.
2. Select **Add new > Custom service provider**.
3. Configure:

| Setting | Value |
| --- | --- |
| Name | `Cortex XDR inventory` |
| Access client ID | Any placeholder value |
| Access client secret | Any placeholder value |
| REST API URL | `https://cortex-posture.example.com/check` |
| Polling frequency | `10 minutes` |

4. Select **Test and save**.

Cloudflare sends the Access client ID and secret to your endpoint as
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on every poll.
This Worker ignores those headers, so the placeholder values are enough —
unless you [secure the endpoint with Access](#securing-the-endpoint-optional),
in which case they must be a real service token's credentials.

Cloudflare only polls `/check` while there are enrolled, online devices to
evaluate, so polls pause overnight when the fleet is powered off.

## Securing the endpoint (optional)

By default every endpoint — including `/check` and the dashboard — accepts
unauthenticated requests. That is safe on a locked-down network and simplest
to operate, but if the Worker URL is reachable by untrusted parties you should
put Cloudflare Access in front of it:

1. Create an Access **service token** and a **self-hosted application** for the
   Worker's hostname.
2. Add a **Service Auth** policy including that service token (this is what the
   custom provider authenticates with — use its real client ID and secret in
   the integration config).
3. Add an **Allow** policy including your administrator emails for the
   dashboard.
4. Do not attach the noncompliant-serial Block policy to this application:
   doing so would prevent Cloudflare from delivering the inventory needed to
   update the list.

The Worker works unchanged behind Access because it never inspects
credentials. A WAF rule restricting source IPs is a lighter alternative.

## Policy setup

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

## Smoke testing

`npm run smoke` curls every endpoint and reports the HTTP status of each:

```bash
BASE_URL="https://cortex-posture.example.com" npm run smoke
```

The script also verifies that invalid query parameters fail with `400` rather
than being ignored. All checks must pass before you attach Block policies.
