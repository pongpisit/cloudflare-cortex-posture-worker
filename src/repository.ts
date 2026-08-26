import type {
  CloudflareDevice,
  CortexEndpoint,
  Evaluation,
  StoredEvaluation,
} from "./types";
import {
  normalizeHostname,
  normalizeMacCollection,
  normalizeTimestamp,
} from "./posture";

interface EvaluationRow {
  cloudflare_device_id: string;
  cortex_endpoint_id: string;
  score: number | null;
  reason: string | null;
  cortex_refreshed_at: number | null;
  hostname: string;
  verified_mac: string;
  serial_number: string | null;
}

interface EndpointIdRow {
  cortex_endpoint_id: string;
}

export async function getStoredEvaluations(
  db: D1Database,
  deviceIds: string[],
): Promise<Map<string, StoredEvaluation>> {
  const evaluations = new Map<string, StoredEvaluation>();

  for (const ids of chunk(deviceIds, 80)) {
    const placeholders = ids.map(() => "?").join(",");
    const query = `
      SELECT m.cloudflare_device_id, m.cortex_endpoint_id,
             s.score, s.reason, s.cortex_refreshed_at,
             m.hostname, m.verified_mac, m.serial_number
      FROM device_mappings m
      LEFT JOIN endpoint_snapshots s
        ON s.cortex_endpoint_id = m.cortex_endpoint_id
      WHERE m.status = 'verified'
        AND m.cloudflare_device_id IN (${placeholders})
    `;
    const result = await db
      .prepare(query)
      .bind(...ids)
      .all<EvaluationRow>();

    for (const row of result.results) {
      evaluations.set(row.cloudflare_device_id, {
        cloudflareDeviceId: row.cloudflare_device_id,
        cortexEndpointId: row.cortex_endpoint_id,
        score: row.score,
        reason: row.reason,
        cortexRefreshedAt: row.cortex_refreshed_at,
        hostname: row.hostname,
        verifiedMac: row.verified_mac,
        serialNumber: row.serial_number,
      });
    }
  }

  return evaluations;
}

export async function claimDueEndpointIds(
  db: D1Database,
  cutoff: number,
  afterId: string,
  limit: number,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT DISTINCT m.cortex_endpoint_id
       FROM device_mappings m
       LEFT JOIN endpoint_snapshots s
         ON s.cortex_endpoint_id = m.cortex_endpoint_id
       LEFT JOIN refresh_leases l
         ON l.cortex_endpoint_id = m.cortex_endpoint_id
       WHERE m.status = 'verified'
         AND m.cortex_endpoint_id > ?
         AND (s.cortex_refreshed_at IS NULL OR s.cortex_refreshed_at <= ?)
         AND (l.leased_until IS NULL OR l.leased_until <= ?)
       ORDER BY m.cortex_endpoint_id
       LIMIT ?`,
    )
    .bind(afterId, cutoff, Date.now(), limit)
    .all<EndpointIdRow>();
  const endpointIds = result.results.map((row) => row.cortex_endpoint_id);
  const leasedUntil = Date.now() + 15 * 60_000;
  const leases = endpointIds.map((endpointId) =>
    db
      .prepare(
        `INSERT INTO refresh_leases(cortex_endpoint_id, leased_until)
         VALUES (?, ?)
         ON CONFLICT(cortex_endpoint_id) DO UPDATE SET
           leased_until = excluded.leased_until`,
      )
      .bind(endpointId, leasedUntil),
  );
  for (const batch of chunk(leases, 100)) await db.batch(batch);
  return endpointIds;
}

export async function saveEndpointSnapshots(
  db: D1Database,
  endpoints: CortexEndpoint[],
  evaluations: Map<string, Evaluation>,
  now: number,
): Promise<void> {
  if (endpoints.length === 0) return;

  const statements = endpoints.map((endpoint) => {
    const evaluation = evaluations.get(endpoint.endpoint_id) ?? {
      score: 0,
      reason: "evaluation_missing",
    };
    return db
      .prepare(
        `INSERT INTO endpoint_snapshots(
           cortex_endpoint_id, endpoint_name, operational_status,
           last_content_update_time, last_seen, score, reason,
           cortex_refreshed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cortex_endpoint_id) DO UPDATE SET
           endpoint_name = excluded.endpoint_name,
           operational_status = excluded.operational_status,
           last_content_update_time = excluded.last_content_update_time,
           last_seen = excluded.last_seen,
           score = excluded.score,
           reason = excluded.reason,
           cortex_refreshed_at = excluded.cortex_refreshed_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        endpoint.endpoint_id,
        String(endpoint.endpoint_name ?? endpoint.host_name ?? ""),
        String(endpoint.operational_status ?? ""),
        normalizeTimestamp(endpoint.last_content_update_time),
        normalizeTimestamp(endpoint.last_seen),
        evaluation.score,
        evaluation.reason,
        now,
        now,
      );
  });

  for (const batch of chunk(statements, 100)) await db.batch(batch);
  await releaseRefreshLeases(
    db,
    endpoints.map((endpoint) => endpoint.endpoint_id),
  );
}

export async function saveDeviceMappings(
  db: D1Database,
  mappings: Array<{ device: CloudflareDevice; endpoint: CortexEndpoint }>,
  now: number,
): Promise<void> {
  const statements = mappings.map(({ device, endpoint }) => {
    const deviceMacs = normalizeMacCollection(device.mac_address);
    const endpointMacs = normalizeMacCollection(endpoint.mac_address);
    const verifiedMac = [...deviceMacs].find((mac) => endpointMacs.has(mac)) ?? "";
    return db.prepare(
      `INSERT INTO device_mappings(
         cloudflare_device_id, serial_number, cortex_endpoint_id,
         hostname, verified_mac, status, created_at, updated_at,
         last_verified_at
       ) VALUES (?, ?, ?, ?, ?, 'verified', ?, ?, ?)
       ON CONFLICT(cloudflare_device_id) DO UPDATE SET
         serial_number = excluded.serial_number,
         cortex_endpoint_id = excluded.cortex_endpoint_id,
         hostname = excluded.hostname,
         verified_mac = excluded.verified_mac,
         status = 'verified',
         updated_at = excluded.updated_at,
         last_verified_at = excluded.last_verified_at`,
    ).bind(
      device.device_id,
      device.serial_number ?? null,
      endpoint.endpoint_id,
      normalizeHostname(device.hostname),
      verifiedMac,
      now,
      now,
      now,
    );
  });
  for (const batch of chunk(statements, 100)) await db.batch(batch);
}

export async function markMissingEndpoints(
  db: D1Database,
  endpointIds: string[],
  now: number,
): Promise<void> {
  const statements = endpointIds.map((endpointId) =>
    db
      .prepare(
        `INSERT INTO endpoint_snapshots(
           cortex_endpoint_id, endpoint_name, operational_status,
           last_content_update_time, last_seen, score, reason,
           cortex_refreshed_at, updated_at
         ) VALUES (?, '', 'missing', 0, 0, 0, 'endpoint_missing', ?, ?)
         ON CONFLICT(cortex_endpoint_id) DO UPDATE SET
           operational_status = 'missing', score = 0,
           reason = 'endpoint_missing', cortex_refreshed_at = ?, updated_at = ?`,
      )
      .bind(endpointId, now, now, now, now),
  );
  for (const batch of chunk(statements, 100)) await db.batch(batch);
  await releaseRefreshLeases(db, endpointIds);
}

export async function recordCortexSuccess(
  db: D1Database,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE integration_status
       SET status = 'healthy', message = NULL, last_success_at = ?, updated_at = ?
       WHERE name = 'cortex'`,
    )
    .bind(now, now)
    .run();
}

export async function recordCortexError(
  db: D1Database,
  message: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE integration_status
       SET status = 'degraded', message = ?, last_error_at = ?, updated_at = ?
       WHERE name = 'cortex'`,
    )
    .bind(message.slice(0, 500), now, now)
    .run();
}

async function releaseRefreshLeases(
  db: D1Database,
  endpointIds: string[],
): Promise<void> {
  for (const ids of chunk(endpointIds, 80)) {
    const placeholders = ids.map(() => "?").join(",");
    await db
      .prepare(
        `DELETE FROM refresh_leases WHERE cortex_endpoint_id IN (${placeholders})`,
      )
      .bind(...ids)
      .run();
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
