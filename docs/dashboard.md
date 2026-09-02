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

## JSON endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/overview` | Integration statuses, device counts, noncompliant serial count, sync state |
| `GET /api/devices?status=all&limit=N` | Per-device compliance rows; `status=all\|noncompliant\|compliant`, `search=<text>`, `limit` 1–500, default 200 |
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
  -H "content-type: application/json" \
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
