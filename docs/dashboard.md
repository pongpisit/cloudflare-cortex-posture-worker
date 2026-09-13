# Dashboard guide

`GET /dashboard` serves an operations page. It shows integration health,
device counts, the current noncompliant serial count, and a filterable device
table (hostname, serial, MAC, score, reason, content age, refresh recency).
The page refreshes every 60 seconds.

The configuration panel manages all operational settings, stored in D1 and
applied on the next Cron run without a redeploy:

- **Load lists** uses the configured `CLOUDFLARE_API_TOKEN` to list the accounts
  and `SERIAL` lists the token can see, so you pick the target list from a
  dropdown instead of pasting a UUID.
- **Content age threshold** (minutes, hours, or days) and **list capacity**
  set the stale boundary and the capacity safety limit (Zero Trust lists
  support 1,000 entries on Standard and 5,000 on Enterprise). Strict
  environments can go as low as 1 minute; the underlying refresh tiers
  (`RECOVERY_REFRESH_MINUTES`, default 30) still bound how often content is
  actually re-checked.
- **Enable list synchronization** is the master switch for list updates. It
  stays disabled until you turn it on.
- **Require MAC corroboration** makes discovery refuse hostname-only matches:
  new devices only bind when Cloudflare's MAC matches a Cortex endpoint's MAC.
  Check the binding-method counts in `/api/overview` before enabling.
- **Excluded hostname patterns** takes comma-separated globs (for example
  `vdi-*,pooled-*`) for machines that must never bind — non-persistent VDI
  pools have no stable identity, so binding would only churn the mapping
  table while their cloned serials poison the denylist. Matching devices fail
  open with zero writes.
- **Sync now** is the one action that makes everything correct and
  up to date: it pulls the Cloudflare device inventory to rebuild any
  missing bindings (recovering a deleted binding even for an offline
  device, which a poll alone cannot do), refreshes Cortex content for
  everything already mapped, and publishes the denylist — all in one call,
  instead of three separate steps run in the right order.
- **Coverage audit** scans the Cortex inventory for endpoints seen in the
  last 30 days and reports how many have a Cloudflare device mapped in D1.
  Each uncovered endpoint is diagnosed, not just listed — and hostname alone
  is never enough to call something a duplicate, since a clone VM can report
  an identical hostname while being different hardware. A hostname collision
  is only treated as the same machine when the endpoint's MAC actually
  matches an already-mapped or already-queued device; the response then
  points at **Sync now** or `GET /api/bindings`. A hostname collision whose
  MAC does *not* match is reported as an ambiguous collision instead — a
  signal to check for a clone or naming collision, not something to ignore.
  Only a hostname with no Cloudflare device at all is a genuine enrollment
  gap. On large fleets the audit performs one Cortex request per 100
  endpoints and can take a while.

Each device row has a **Check** button that refreshes that single device from
Cortex on demand and updates the row with the result. Rows also have
checkboxes (with select-all) — **Check selected** refreshes up to 100 devices
in a single Cortex request, and **Delete selected** removes devices from
tracking. The **search bar** filters devices by hostname, serial, or MAC
address.

Deleting a device removes its mapping and observations, tombstones its serial
so the next synchronization removes it from the denylist, and deletes the
endpoint snapshot when no other mapping references it. Devices that are still
enrolled and reported by the provider are re-discovered on a later poll. As a
safety guard, deleting a device the provider reported in the last 48 hours
fails with 409 — the row is likely active, and deleting it would open a
brief enforcement gap. The dashboard's **Delete** and **Delete selected**
buttons catch this and ask for confirmation before retrying with `force`;
scripted callers add `"force": true` to `POST /api/devices/delete` directly.

The **Debug log** button opens a chat-style popup that streams the most recent
Cortex requests and responses live — requests appear as outgoing bubbles,
responses as incoming ones, with method, URL, status, duration, headers
(authorization redacted), and bodies behind a click. It is controlled by the
**Log Cortex traffic** setting and retains the last 200 entries in D1.

## JSON endpoints

Mutating endpoints (`POST`/`PUT`/`DELETE` rows below) require the
`x-management-token: <secret>` header while the `MANAGEMENT_TOKEN` Worker
secret is set; without it they return `401`. Read-only `GET` endpoints and the
dashboard page itself stay open.

| Endpoint | Description |
| --- | --- |
| `GET /api/overview` | Integration statuses, device counts, noncompliant serial count, sync state |
| `GET /api/devices?status=all&limit=N` | Per-device compliance rows; `status=all\|noncompliant\|compliant`, `search=<text>`, `limit` 1–500, default 200 |
| `POST /api/sync` | **The one sync action** (what the dashboard's "Sync now" button calls): pulls the Cloudflare device inventory to rebuild any missing bindings, refreshes Cortex content for every mapped endpoint, then publishes the denylist. Each step is best-effort — a Cloudflare or Cortex error is reported under `resync.error` / `refresh.error` rather than blocking the rest. Returns `resync`, `refresh`, `changed`, `count` |
| `POST /api/devices/refresh` | Advanced primitive behind "Sync now": refresh specific devices from Cortex, `{"deviceId": "..."}` or `{"deviceIds": [...]}` up to 100; or `{"all": true}` for every mapped endpoint without a Cloudflare resync first |
| `POST /api/devices/resync` | Advanced primitive behind "Sync now": pull the Cloudflare device inventory and queue discovery for every unmapped, non-excluded, non-revoked device, without also refreshing Cortex content or publishing |
| `POST /api/devices/delete` | Delete devices from tracking: `{"deviceId": "..."}` or `{"deviceIds": [...]}` up to 100. Devices the provider reported in the last 48 hours are refused with 409 — add `"force": true` to override, since deletion removes their serial from the denylist on the next sync |
| `POST /api/coverage?windowDays=30` | Diff the recently seen Cortex inventory against D1 mappings; returns `scanned`, `covered`, `uncovered`, `coverage_percent`, `truncated`, and an `uncovered_sample` of up to 100 endpoints, each with a MAC-corroborated `reason` (`duplicate_of_mapped_device`, `queued_for_operator_review`, `ambiguous_hostname_shared_by_multiple_devices`, or `no_cloudflare_device`) and a `fix` describing what to do |
| `GET /api/bindings` | The operator queue: unbound devices (clone contention, ambiguity, MAC-strict refusals) with candidate Cortex endpoints, drifted bindings, and the serial-integrity report (duplicate, junk, and missing serials) |
| `POST /api/bindings` | Pin an unbound device to a specific Cortex endpoint permanently: `{"device_id": "...", "endpoint_id": "..."}`. Refuses endpoints actively claimed by a different device (409) |
| `DELETE /api/bindings` | Release a device entirely (undo a wrong pin, drop a cloned enrollment): `{"device_id": "..."}` — removes the mapping and tombstones the serial for the next sync. Devices reported in the last 48 hours require `"force": true` (409 otherwise) |
| `GET /api/debug-log?limit=N` | Recent Cortex request/response pairs, `limit` 1–200, default 50 |
| `DELETE /api/debug-log` | Clear the debug log |
| `GET /api/settings` | Current operational settings and readiness flags |
| `PUT /api/settings` | Update settings: `cloudflareAccountId`, `serialListId`, `serialListName`, `listSyncEnabled`, `maxContentAgeMinutes` (1–525600; whole-day `maxContentAgeDays` still accepted and converted), `listMaxItems` (1–100000), `debugLogEnabled`, `requireMacCorroboration`, `vdiHostnamePatterns` (comma-separated exclusion globs) |
| `GET /api/cloudflare/lists` | Accounts and `SERIAL` lists visible to the API token |

Settings can also be updated directly:

```bash
curl -X PUT "https://cortex-posture.example.com/api/settings" \
  -H "content-type: application/json" \
  -H "x-management-token: <MANAGEMENT_TOKEN secret>" \
  -d '{"serialListId": "<list-id>", "listSyncEnabled": true}'
```

## Scripted bootstrap

For scripted deployments, set a `BOOTSTRAP_SETTINGS` secret to a JSON object.
The next Cron run applies any unset settings (existing dashboard values are
never overwritten), after which the secret can be deleted:

```bash
echo '{"cloudflare_account_id":"<account-id>","serial_list_id":"<list-id>","list_sync_enabled":"true"}' |
  npx wrangler secret put BOOTSTRAP_SETTINGS
```
