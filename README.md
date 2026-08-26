# Cloudflare Cortex XDR Posture Worker

A production-oriented Cloudflare custom device posture provider that checks
Palo Alto Cortex XDR endpoint protection and content freshness.

The Worker returns score `100` only when the most recent Cortex snapshot shows:

- `operational_status` is `protected`
- `last_content_update_time` is no more than seven days old
- Optional `last_seen` freshness passes

![Architecture](docs/architecture.svg)

## How it scales

Cloudflare calls `POST /check` on the custom service provider polling interval,
not on every application request. The request path reads scores from D1 and does
not wait for Cortex.

A five-minute Cron trigger finds stale mappings and sends endpoint batches to a
Cloudflare Queue. Queue consumers call Cortex `get_endpoint` with up to 100
endpoint IDs and update D1. New devices are discovered asynchronously by exact
normalized hostname plus at least one matching MAC address. Stored hostname,
verified MAC, and serial (when present) are rechecked on every Cloudflare poll;
a changed identity returns score `0` and triggers rediscovery.

This architecture is intended for fleets of roughly 5,000 to 50,000 devices.

## Failure behavior

The selected policy is controlled fail-open:

- A previously verified device retains its last known score during a Cortex
  outage.
- A device whose last known score was `0` remains failed.
- Unknown, unmapped, or ambiguous devices receive score `0`.
- Stale score use and Cortex failures are emitted as structured logs.

Create an emergency Access policy for approved administrators before broad
enforcement.

## Components

- Cloudflare Worker HTTP, scheduled, and Queue handlers
- Cloudflare Access JWT validation with rotating JWKS via `jose`
- D1 mappings, endpoint snapshots, and integration health
- Cortex standard and advanced API-key authentication
- Queue retries and a dead-letter queue
- Presentation-ready SVG and Mermaid architecture diagrams

## Local development

Requirements: Node.js 20 or newer and a Cloudflare account.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run types
npm run migrate:local
npm run dev
```

Update non-secret values in `wrangler.jsonc`. Put local Cortex credentials only
in `.dev.vars`; the file is ignored by Git.

## Verification

```bash
npm run check
```

This generates binding types, type-checks, runs unit tests, and performs a
Wrangler deployment dry run.

## Deployment

See [docs/deployment.md](docs/deployment.md) for Cloudflare, Cortex, Access, and
custom posture setup. The short version is:

```bash
npx wrangler d1 migrations apply cortex-posture --remote
npx wrangler secret put CORTEX_API_KEY
npx wrangler secret put CORTEX_API_KEY_ID
npm run deploy
```

Never commit Cortex keys or the Access service-token secret.

## Posture API

Cloudflare sends up to 1,000 devices:

```json
{
  "devices": [
    {
      "device_id": "9ece5fab-7398-488a-a575-e25a9a3dec07",
      "email": "jdoe@example.com",
      "serial_number": "PF123ABC",
      "mac_address": "00:11:22:33:44:55",
      "virtual_ipv4": "100.96.0.10",
      "hostname": "LAPTOP-001"
    }
  ]
}
```

The Worker returns one entry for every device:

```json
{
  "result": {
    "9ece5fab-7398-488a-a575-e25a9a3dec07": {
      "s2s_id": "cortex-endpoint-id",
      "score": 100
    }
  }
}
```

An unknown device initially receives score `0` while a discovery message is
queued. After Cortex confirms one hostname-and-MAC match, the mapping is stored
and subsequent Cloudflare polls use the cached evaluation.
