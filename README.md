# Cloudflare Cortex XDR Noncompliance List Worker

This Worker maps Cloudflare Zero Trust devices to Cortex XDR endpoints and
maintains a Cloudflare Zero Trust serial-number list containing only devices
whose Cortex security content is too old. Access and Gateway policies use that
list as a block condition, so noncompliant devices lose access without any
per-request evaluation for healthy devices — and unknown devices intentionally
fail open until a later discovery and refresh cycle confirms they are stale.

A device is mapped to exactly one Cortex endpoint by **normalized hostname plus
MAC address**. The hardware serial number is never used for matching; it is
only the enforcement key written to the denylist, and it follows the device
automatically if it changes.

The stale-content threshold defaults to seven days and is managed from the
operations dashboard, along with every other operational setting. The Worker
never creates or evaluates policies; it only maintains the list, which you
attach to policies as a condition.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pongpisit/cloudflare-cortex-posture-worker)

## Contents

- [How it works](#how-it-works)
- [Usage and cost](#usage-and-cost)
- [Failure model](#failure-model)
- [Documentation](#documentation)

## How it works

```mermaid
flowchart LR
  D["Managed device"] --> CP["Custom service provider"]
  CP -->|"Device ID, serial, hostname, MAC"| W["Worker /check"]
  W -->|"Unknown device"| Q["Cloudflare Queue"]
  C["Cron trigger"] -->|"Known endpoint batches"| Q
  Q -->|"Cortex API"| X["Cortex XDR"]
  X -->|"Content update time, hostname, MAC"| Q
  Q -->|"Verified mappings and snapshots"| DB[("D1")]
  C -->|"Stale device serials"| L["SERIAL denylist"]
  L --> A["Access Block policy"]
  L --> G["Gateway Block policy"]
```

The integration has three asynchronous stages:

1. The Cloudflare custom service provider sends device inventory to `/check`.
2. The Worker maps an unknown device to exactly one Cortex endpoint using the
   normalized hostname, disambiguated by MAC address when several Cortex
   endpoints share that hostname. The matched MAC is stored as the mapping's
   verified MAC.
3. Cron refreshes known Cortex endpoints in batches and replaces the Zero Trust
   serial list with mapped devices whose `last_content_update_time` is older
   than the configured content-age threshold.

Cortex documents `last_content_update_time` as a response field, not a
supported `get_endpoint` filter. The Worker must therefore refresh known
endpoint IDs in batches of 100, but only the much smaller noncompliant serial
set is published to Cloudflare policy.

### Endpoint identity over time

The mapping identity is **hostname + MAC**: a rename or a NIC change
invalidates the mapping and triggers re-discovery. `endpoint_id` is Cortex's
stable key, so refreshes are keyed by ID. Mappings stay correct as the fleet
changes:

- Every `/check` re-verifies each stored mapping against current inventory.
  A hostname or MAC change invalidates the mapping, writes a removal tombstone
  for the old serial, and triggers re-discovery under the new identity.
- A serial-number change never invalidates a mapping. The denylist entry
  silently follows the current serial, so hardware replacements never leave a
  stale block in place.
- An endpoint that no longer exists in Cortex fails open: its snapshot is
  cleared so the device stays allowed, and it is retried on later cycles.
- Once per hour the Worker re-runs hostname discovery for mappings whose
  endpoint disappeared. When the Cortex agent was reinstalled on the same
  machine (new `endpoint_id`, same hostname — for example after a re-image),
  the mapping is re-pointed to the current endpoint and the snapshot is
  restored.
- Identity checks tolerate missing data: a poll that omits the MAC never
  invalidates a mapping that has one, and vice versa.

### Behavior

For an expected 12,000-device fleet with 1–5% stale endpoints, the list
normally contains approximately 120–600 serial numbers.

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
type, and configured capacity, and verifies the returned items after writing.

There is no bulk import of Cortex endpoint IDs — the Worker learns them
organically from `/check` inventory, so a device that appears in a poll is
denylist-eligible within one five-minute Cron cycle. At 10-minute provider
polling, a 12,000-device fleet is fully learned within the first one or two
polls. Endpoints that never enroll in Cloudflare are never learned, which is
correct: the denylist only affects devices Cloudflare can evaluate.

## Usage and cost

All numbers are for the reference fleet — 12,000 devices, 1–5% stale, default
intervals (4-hour detection sweep, 30-minute recovery refresh, 10-minute
provider polling) — against current Workers Paid plan pricing:

| Dimension | Estimated monthly usage | Included allowance | Overage |
| --- | --- | --- | --- |
| Workers requests | ~25–50k | 10M | $0 |
| Workers CPU time | ~2–5M CPU-ms | 30M | $0 |
| D1 rows written | ~9–13M | 50M | $0 |
| D1 rows read | ~50–100M | 25B | $0 |
| D1 storage | <50 MB | 5 GB | $0 |
| Queues operations | ~100k | 1M | $0 |

**Bottom line: the deployment costs $5/month — the Workers Paid plan itself —
and every metered dimension stays comfortably inside the included
allowances.**

Per-device steady-state formulas for sizing your own fleet:

- D1 rows written: **~750 per healthy device per month**, plus **~5,760 per
  stale device per month** (the recovery tier), plus a once-daily last-seen
  touch.
- D1 rows read: **~4,500 per device per month**.

Scaling notes:

- The D1 write ceiling (50M rows/month) is reached at roughly **65,000
  devices** with default intervals. `DETECTION_REFRESH_MINUTES` scales writes
  linearly: raising it from 4 hours to 24 hours supports proportionally larger
  fleets.
- The Workers Free plan caps D1 at 100,000 rows written per day, which supports
  roughly **3,000–4,000 devices** at default intervals. Use it for pilots; use
  Workers Paid for production fleets. When a free-plan limit is hit, D1 returns
  errors until the daily reset — the failure model preserves the last published
  list, but decisions stop updating.

Current pricing references: [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/).

## Failure model

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

## Documentation

- [Architecture guide](docs/architecture.md) — every API call, data flow,
  comparison logic, and the D1 schema.
- [Setup guide](docs/setup.md) — deploy, Cortex configuration, serial list,
  custom provider, policies, validation, and smoke testing.
- [Dashboard guide](docs/dashboard.md) — the operations dashboard and every
  JSON endpoint.
- [Operations guide](docs/operations.md) — refresh tiers, long-term operation,
  monitoring, and configuration reference.

Quick start: use the deploy button above, follow the
[setup guide](docs/setup.md) from step 1, then run the
[smoke test](docs/setup.md#smoke-testing) and
[validation checklist](docs/setup.md#validation).
