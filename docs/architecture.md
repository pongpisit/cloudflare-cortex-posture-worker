# Architecture guide

This guide details every API call, where data is stored, and how the Worker
compares it. For the high-level overview, see the
[README](../README.md#how-it-works).

## Contents

- [System context](#system-context)
- [End-to-end data flow](#end-to-end-data-flow)
- [Decision logic](#decision-logic)
- [API reference](#api-reference)
- [Data storage](#data-storage)

## System context

```mermaid
flowchart TB
  subgraph CF["Cloudflare Zero Trust"]
    P["Custom service provider (10 min polls)"]
    L["SERIAL denylist list"]
    A["Access Block policy"]
    G["Gateway Block policy"]
  end
  subgraph W["Worker (Cron every 5 minutes)"]
    C1["/check handler"]
    C2["Queue consumer"]
    C3["List sync"]
  end
  DB[("D1 database")]
  X["Cortex XDR API"]

  P -->|"device inventory"| C1
  C1 -->|"read / write"| DB
  C1 -->|"discoveries + missing snapshots"| C2
  C3 -->|"claim due endpoints"| DB
  C3 -->|"refresh batches"| C2
  C2 -->|"get_endpoint"| X
  C2 -->|"mappings + snapshots"| DB
  C3 -->|"noncompliant serials"| L
  L --> A
  L --> G
```

The Worker only maintains the list. Enforcement happens inside Cloudflare when
Access or Gateway policies evaluate the device's serial against the list.

## End-to-end data flow

```mermaid
sequenceDiagram
    autonumber
    participant P as Cloudflare provider
    participant W as Worker
    participant DB as D1
    participant Q as Queue
    participant CX as Cortex XDR API
    participant ZT as Zero Trust list API

    P->>W: POST /check (device_id, serial, hostname, MAC)
    W->>DB: read device_mappings + endpoint_snapshots
    alt Unknown device
        W->>Q: enqueue discovery
    else Hostname or MAC changed
        W->>DB: invalidate mapping, tombstone old serial
        W->>Q: enqueue discovery
    else Identity verified
        W-->>P: score from stored snapshot
        Note over W,P: missing snapshot fails open with score 0
    end

    Q->>CX: get_endpoint (hostname filter)
    CX-->>Q: endpoint_id, endpoint_name, MACs, content time
    Note over Q: unique hostname maps directly, duplicate hostnames require a MAC match
    Q->>DB: save mapping + endpoint snapshot

    Note over W: Cron every 5 minutes
    W->>DB: claim due endpoints (recovery 30m, detection 4h)
    W->>Q: enqueue refresh batches of 100
    Q->>CX: get_endpoint (endpoint_id_list filter)
    CX-->>Q: last_content_update_time per endpoint
    Q->>DB: update snapshot, score, refreshed_at

    W->>DB: collect noncompliant serials minus tombstones
    W->>ZT: PUT full serial list (sentinel when empty)
    Note over ZT: Access and Gateway Block policies evaluate the list
```

Poll cadence: Cloudflare delivers inventory on its own schedule (about every
10 minutes while devices are online). The Worker answers from stored snapshots
without calling Cortex, so poll latency does not depend on Cortex availability.

## Decision logic

### /check identity check (per polled device)

```mermaid
flowchart TD
    P["Polled device"] --> K{"Mapping exists?"}
    K -->|"no"| D["Queue discovery"]
    K -->|"yes"| I{"Hostname and MAC match?"}
    I -->|"no"| V["Invalidate, tombstone old serial, rediscover"]
    I -->|"yes"| S{"Serial changed?"}
    S -->|"yes"| U["Silent update, denylist follows new serial"]
    S -->|"no"| R["Return snapshot score"]
```

- A MAC change only invalidates when both the stored MAC and the polled MAC
  are present and different. A poll without a MAC never invalidates.
- A serial change never invalidates the mapping — it is silently updated so
  the denylist entry follows the current hardware.

### Cortex matching at discovery

1. Normalize the polled hostname (trim, drop the trailing dot, lowercase) and
   query Cortex by hostname.
2. Exactly one Cortex endpoint with that hostname → map directly.
3. Several endpoints share the hostname → intersect their `mac_address[]`
   sets with the polled MAC. Exactly one match → map and store that MAC as
   the verified MAC. Zero or multiple matches → leave unmapped (fail open).

### Compliance decision (per refreshed endpoint)

```mermaid
flowchart TD
    F["Cortex get_endpoint reply"] --> T{"last_content_update_time present?"}
    T -->|"no"| FO["Fail open: not added"]
    T -->|"yes"| A["content_age = refresh_time - last_content_update_time"]
    A --> C{"content_age > threshold?"}
    C -->|"yes"| ST["Score 0: serial enters denylist, recovery tier refresh"]
    C -->|"no"| OK["Score 100: serial removed, detection tier refresh"]
```

- The threshold is the dashboard-managed content age setting
  (`maxContentAgeDays`, default 7 days).
- Content age is measured at the successful Cortex refresh time, so
  wall-clock aging during an outage cannot create a new denial.
- Only `last_content_update_time` matters. Cortex `operational_status` and
  `last_seen` are stored for visibility but never affect the decision.
- Denylisted endpoints are re-checked every 30 minutes (recovery tier) so
  recovered devices are unblocked promptly; everything else is swept every
  4 hours (detection tier).

## API reference

### Inbound: Cloudflare provider → `POST /check`

| Field | Use |
| --- | --- |
| `device_id` | Cloudflare device UUID (primary key of a mapping) |
| `hostname` | Identity: compared against the mapped endpoint name |
| `mac_address` | Identity: compared against the mapping's verified MAC |
| `serial_number` | Enforcement key tracked for the denylist |
| `email`, `virtual_ipv4` | Stored for visibility only |

Response: `{"result": {"<device_id>": {"s2s_id": "<endpoint_id>", "score": 0-100}}}`.
Up to 1,000 devices per request.

### Outbound: Cortex XDR API

One endpoint, two filters:

| Call | Body | When |
| --- | --- | --- |
| `POST /public_api/v1/endpoints/get_endpoint` | `filters: [{field: "hostname", operator: "in", value: [...]}]`, paginated 100/page, 10 hostnames per request | Discovery of unknown or invalidated devices |
| `POST /public_api/v1/endpoints/get_endpoint` | `filters: [{field: "endpoint_id_list", operator: "in", value: [...]}]`, 100 IDs per request | Scheduled refresh of known endpoints |

Authentication (advanced API key): `x-xdr-auth-id` carries the key ID,
`x-xdr-nonce` a random value, `x-xdr-timestamp` the epoch time, and
`authorization` the hex SHA-256 digest of `API key + nonce + timestamp`.
Standard keys send the API key directly in `authorization`.

Expected reply fields per endpoint: `endpoint_id`, `endpoint_name`,
`mac_address[]`, `last_content_update_time`, `last_seen`,
`operational_status`.

Resilience: 3 attempts with backoff, `retry-after` honored on 429/5xx,
15-second timeout per attempt. Every request/response pair is optionally
recorded in the debug log with the authorization redacted.

### Outbound: Cloudflare Zero Trust Lists API

| Call | Purpose |
| --- | --- |
| List `SERIAL` lists | Dashboard list selector and pre-write validation (ID, name, type) |
| Replace list items | Full-set replacement with the noncompliant serials, or the `__cortex_no_noncompliant_devices__` sentinel when empty |

The sync validates the configured capacity before writing, skips the PUT when
nothing changed, re-reads the list after writing to verify, and holds a D1
lease so overlapping Cron runs cannot interleave replacements. Entries carry
`hostname=<name>; mac=<address>` descriptions for operators.

## Data storage

All state lives in D1:

| Table | Purpose |
| --- | --- |
| `device_mappings` | One row per Cloudflare device: `cortex_endpoint_id`, hostname, verified MAC, serial, status, `last_seen_at` |
| `endpoint_snapshots` | One row per Cortex endpoint: `last_content_update_time`, score, reason, `cortex_refreshed_at` |
| `serial_removals` | Durable tombstones that remove invalidated or changed serials from the denylist |
| `device_observations` | Concurrency guard: mapping writes only apply to observations from the same poll |
| `refresh_leases`, `sync_leases` | Prevent duplicate Cortex refreshes and list replacements across overlapping runs |
| `app_settings` | Dashboard-managed settings and provider liveness (`last_check_at`) |
| `integration_status` | Health-pill state for the Cortex and list integrations |
| `debug_log` | Last 200 Cortex request/response pairs for the dashboard popup |

The Worker self-provisions this entire schema on the first Cron run, so a
deployment bound to a fresh database recovers without manual migrations.
