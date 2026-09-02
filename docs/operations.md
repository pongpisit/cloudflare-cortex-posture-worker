# Operations guide

Day-to-day commands, refresh behavior, and what to expect over years of
unattended operation.

## Commands

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

`GET /health` reports Cortex and serial-list integration timestamps. Relevant
structured events include:

- `serial_denylist_synchronized`
- `serial_denylist_sync_error`
- `serial_denylist_capacity_warning`
- `device_mapping_failed`
- `scheduled_refresh`
- `cortex_refresh_error`

The Worker refuses to update when the desired count exceeds the configured list
capacity and warns at 80% capacity.

## Refresh tiers

Cortex refreshes use two tiers:

- **Recovery tier** — endpoints whose last-known content is stale (the current
  denylist members) are re-checked every `RECOVERY_REFRESH_MINUTES` (default
  30) so recovered devices are unblocked promptly.
- **Detection tier** — everything else is swept only every
  `DETECTION_REFRESH_MINUTES` (default 240), because detecting a device that
  crossed the content-age threshold is just as correct hours later.

This keeps D1 write volume proportional to the noncompliant population rather
than the fleet — see the
[usage and cost section](../README.md#usage-and-cost) in the README.

D1 write volume also stays proportional to fleet churn rather than fleet size:
each provider poll only writes observation rows for devices that need action
(discovery, serial updates, invalidation) instead of the full inventory, and
the debug log is pruned to the most recent 200 entries.

## Long-term operation

The system is designed to run unattended for years. What ages, and how it is
handled:

- **Credential expiry is the main silent risk.** API tokens and Cortex keys
  have their own lifetimes. When a credential dies, the dashboard shows it:
  the Provider pill goes degraded when `/check` polls stop, and the Cortex and
  serial-list pills go degraded when their APIs fail. Rotate the secrets,
  recreate the service provider integration, and verify all pills return
  healthy. Check expiry dates at least twice a year.
- **The Provider pill also reports quiet fleets.** Cloudflare only polls
  `/check` while there are enrolled, online devices to evaluate. When every
  device is powered off or disconnected from the Cloudflare One Client, polls
  stop and the pill degrades even though the integration is healthy. In
  **Zero Trust > Team & Resources > Devices**, compare each device's
  `last_seen` with the Provider pill's timestamp before treating a stale pill
  as an outage.
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
  Cortex agent is reinstalled (see
  [endpoint identity over time](../README.md#endpoint-identity-over-time)),
  so re-imaged fleets require no manual reconciliation.
- **Monitoring:** point an external uptime monitor at `GET /health` and review
  the dashboard periodically. All state lives in D1 and every operational
  decision is visible as a structured log event.
- **Dependencies are zero** (the Worker uses only platform APIs). Run
  `npm run check` during any routine maintenance window; `npx wrangler
  rollback` restores the previous Worker version if a deploy misbehaves.

## Configuration reference

Worker secrets (set via `npx wrangler secret put` or the deploy flow):

- `CORTEX_BASE_URL` — Cortex API HTTPS origin
- `CORTEX_API_KEY` — Cortex XDR API key with endpoint-read access
- `CORTEX_API_KEY_ID` — API key ID from the Cortex API Keys page
- `CLOUDFLARE_API_TOKEN` — account-scoped Zero Trust Write; also powers the
  dashboard list selector

Dashboard-managed settings (stored in D1, with defaults):

| Setting | Default | Purpose |
| --- | --- | --- |
| Cloudflare account | unset | Account that owns the managed list |
| Serial list | unset | Zero Trust SERIAL list to manage |
| Content age threshold | `7` days | Stale-content boundary; use `14` for two weeks |
| List capacity | `1000` | Safety limit; `5000` on Enterprise entitlements |
| List synchronization | disabled | Master switch for list updates |
| Cortex traffic logging | enabled | Store recent Cortex request/response pairs for the debug panel |

Advanced overrides (set as Worker variables only when needed):
`RECOVERY_REFRESH_MINUTES` (`30`), `DETECTION_REFRESH_MINUTES` (`240`),
`STALE_DEVICE_DAYS` (`30`), `CORTEX_TIMEOUT_MS` (`15000`),
`CORTEX_KEY_TYPE` (`advanced`).

## Official documentation

- [Cloudflare Zero Trust lists](https://developers.cloudflare.com/cloudflare-one/reusable-components/lists/)
- [Cloudflare device serial numbers](https://developers.cloudflare.com/cloudflare-one/reusable-components/posture-checks/client-checks/corp-device/)
- [Cloudflare custom device posture integration](https://developers.cloudflare.com/cloudflare-one/integrations/service-providers/custom/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Cloudflare Gateway Network policies](https://developers.cloudflare.com/cloudflare-one/traffic-policies/network-policies/)
- [Cloudflare Zero Trust Lists API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/gateway/subresources/lists/)
- [Cortex XDR API key setup](https://cortex-docs.paloaltonetworks.com/xdr-5-api/create-a-new-api-key)
