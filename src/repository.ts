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

interface SerialDecisionRow {
  serial_number: string;
  noncompliant: number;
}

export interface SerialComplianceDecision {
  serialNumber: string;
  noncompliant: boolean;
}

export async function getStoredEvaluations(
  db: D1Database,
  deviceIds: string[],
  verifiedAfter?: number,
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
        ${verifiedAfter === undefined ? "" : "AND m.last_verified_at >= ?"}
        AND m.cloudflare_device_id IN (${placeholders})
    `;
    const result = await db
      .prepare(query)
      .bind(...(verifiedAfter === undefined ? ids : [verifiedAfter, ...ids]))
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

export async function invalidateDeviceMappings(
  db: D1Database,
  deviceIds: string[],
  observationId: string,
): Promise<void> {
  const now = Date.now();
  const statements = deviceIds.flatMap((deviceId) => [
    db
      .prepare(
        `INSERT INTO serial_removals(serial_number, observed_at)
         SELECT TRIM(serial_number), ? FROM device_mappings
         WHERE cloudflare_device_id = ?
           AND serial_number IS NOT NULL AND TRIM(serial_number) != ''
           AND EXISTS (
             SELECT 1 FROM device_observations o
             WHERE o.cloudflare_device_id = device_mappings.cloudflare_device_id
               AND o.observation_id = ?
           )
         ON CONFLICT(serial_number) DO UPDATE SET
           observed_at = MAX(serial_removals.observed_at, excluded.observed_at)`,
      )
      .bind(now, deviceId, observationId),
    db
      .prepare(
        `UPDATE device_mappings
         SET status = 'invalid', updated_at = ?
         WHERE cloudflare_device_id = ?
           AND EXISTS (
             SELECT 1 FROM device_observations o
             WHERE o.cloudflare_device_id = device_mappings.cloudflare_device_id
               AND o.observation_id = ?
           )`,
      )
      .bind(now, deviceId, observationId),
  ]);
  for (const batch of chunk(statements, 100)) await db.batch(batch);
}

export async function saveDeviceObservations(
  db: D1Database,
  deviceIds: string[],
  observationId: string,
  observedAt: number,
): Promise<void> {
  const statements = deviceIds.map((deviceId) =>
    db
      .prepare(
        `INSERT INTO device_observations(
           cloudflare_device_id, observation_id, observed_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(cloudflare_device_id) DO UPDATE SET
           observation_id = excluded.observation_id,
           observed_at = excluded.observed_at
         WHERE excluded.observed_at > device_observations.observed_at
            OR (
              excluded.observed_at = device_observations.observed_at
              AND excluded.observation_id > device_observations.observation_id
            )`,
      )
      .bind(deviceId, observationId, observedAt),
  );
  for (const batch of chunk(statements, 100)) await db.batch(batch);
}

export async function claimDueEndpointIds(
  db: D1Database,
  cutoff: number,
  afterId: string,
  limit: number,
): Promise<{
  endpointIds: string[];
  nextAfterId: string;
  leaseToken: string;
}> {
  const claimedAt = Date.now();
  const leaseToken = crypto.randomUUID();
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
    .bind(afterId, cutoff, claimedAt, limit)
    .all<EndpointIdRow>();
  const endpointIds = result.results.map((row) => row.cortex_endpoint_id);
  const leasedUntil = claimedAt + 15 * 60_000;
  const leases = endpointIds.map((endpointId) =>
    db
      .prepare(
        `INSERT INTO refresh_leases(cortex_endpoint_id, leased_until, lease_token)
         VALUES (?, ?, ?)
         ON CONFLICT(cortex_endpoint_id) DO UPDATE SET
           leased_until = excluded.leased_until,
           lease_token = excluded.lease_token
         WHERE refresh_leases.leased_until <= ?`,
      )
      .bind(endpointId, leasedUntil, leaseToken, claimedAt),
  );
  for (const batch of chunk(leases, 100)) await db.batch(batch);
  const claimedIds: string[] = [];
  for (const ids of chunk(endpointIds, 80)) {
    const placeholders = ids.map(() => "?").join(",");
    const claimed = await db
      .prepare(
        `SELECT cortex_endpoint_id FROM refresh_leases
         WHERE lease_token = ?
           AND cortex_endpoint_id IN (${placeholders})`,
      )
      .bind(leaseToken, ...ids)
      .all<EndpointIdRow>();
    claimedIds.push(...claimed.results.map((row) => row.cortex_endpoint_id));
  }
  return {
    endpointIds: claimedIds,
    nextAfterId: endpointIds.at(-1) ?? afterId,
    leaseToken,
  };
}

export async function getSerialComplianceDecisions(
  db: D1Database,
  maximumContentAge: number,
  refreshedAfter: number,
): Promise<SerialComplianceDecision[]> {
  const result = await db
    .prepare(
      `SELECT TRIM(m.serial_number) AS serial_number,
              MAX(CASE
                 WHEN s.last_content_update_time > 0
                  AND s.last_content_update_time < s.cortex_refreshed_at - ? THEN 1
                ELSE 0
              END) AS noncompliant
       FROM device_mappings m
       LEFT JOIN endpoint_snapshots s
         ON s.cortex_endpoint_id = m.cortex_endpoint_id
       WHERE m.status = 'verified'
         AND m.serial_number IS NOT NULL
         AND TRIM(m.serial_number) != ''
       GROUP BY TRIM(m.serial_number)
       HAVING COUNT(s.cortex_endpoint_id) = COUNT(*)
          AND MIN(s.cortex_refreshed_at) >= ?
       UNION ALL
       SELECT r.serial_number, 0 AS noncompliant
       FROM serial_removals r
       WHERE NOT EXISTS (
         SELECT 1 FROM device_mappings m
         WHERE m.status = 'verified'
           AND TRIM(m.serial_number) = r.serial_number
       )
       ORDER BY serial_number`,
    )
    .bind(maximumContentAge, refreshedAfter)
    .all<SerialDecisionRow>();
  return result.results.map((row) => ({
    serialNumber: row.serial_number,
    noncompliant: row.noncompliant === 1,
  }));
}

export async function updateVerifiedDeviceSerials(
  db: D1Database,
  devices: Array<{ deviceId: string; serialNumber: string | null }>,
  observationId: string,
  observedAt: number,
): Promise<void> {
  const statements = devices.flatMap(({ deviceId, serialNumber }) => [
    db
      .prepare(
        `INSERT INTO serial_removals(serial_number, observed_at)
         SELECT TRIM(serial_number), ? FROM device_mappings
         WHERE cloudflare_device_id = ?
           AND serial_number IS NOT NULL AND TRIM(serial_number) != ''
           AND TRIM(serial_number) != COALESCE(?, '')
           AND EXISTS (
             SELECT 1 FROM device_observations o
             WHERE o.cloudflare_device_id = device_mappings.cloudflare_device_id
               AND o.observation_id = ?
           )
         ON CONFLICT(serial_number) DO UPDATE SET
           observed_at = MAX(serial_removals.observed_at, excluded.observed_at)`,
      )
      .bind(observedAt, deviceId, serialNumber, observationId),
    db
      .prepare(
        `UPDATE device_mappings
         SET serial_number = ?, updated_at = ?, last_verified_at = ?
         WHERE cloudflare_device_id = ?
           AND status = 'verified'
           AND EXISTS (
             SELECT 1 FROM device_observations o
             WHERE o.cloudflare_device_id = device_mappings.cloudflare_device_id
               AND o.observation_id = ?
           )`,
      )
      .bind(serialNumber, observedAt, observedAt, deviceId, observationId),
    db
      .prepare(
        `DELETE FROM serial_removals
         WHERE serial_number = ?
           AND EXISTS (
             SELECT 1 FROM device_mappings m
             WHERE m.cloudflare_device_id = ?
               AND m.status = 'verified'
               AND TRIM(m.serial_number) = ?
           )`,
      )
      .bind(serialNumber, deviceId, serialNumber),
  ]);
  for (const batch of chunk(statements, 100)) await db.batch(batch);
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
            updated_at = excluded.updated_at
          WHERE excluded.cortex_refreshed_at >= endpoint_snapshots.cortex_refreshed_at`,
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
}

export async function saveDeviceMappings(
  db: D1Database,
  mappings: Array<{ device: CloudflareDevice; endpoint: CortexEndpoint }>,
  observationId: string,
  observedAt: number,
): Promise<void> {
  const statements = mappings.flatMap(({ device, endpoint }) => {
    const deviceMacs = normalizeMacCollection(device.mac_address);
    const endpointMacs = normalizeMacCollection(endpoint.mac_address);
    const verifiedMac = [...deviceMacs].find((mac) => endpointMacs.has(mac)) ?? "";
    const serialNumber = device.serial_number?.trim() || null;
    return [
      db
        .prepare(
          `INSERT INTO serial_removals(serial_number, observed_at)
           SELECT TRIM(serial_number), ? FROM device_mappings
           WHERE cloudflare_device_id = ?
             AND serial_number IS NOT NULL AND TRIM(serial_number) != ''
             AND TRIM(serial_number) != COALESCE(?, '')
             AND EXISTS (
               SELECT 1 FROM device_observations o
               WHERE o.cloudflare_device_id = device_mappings.cloudflare_device_id
                 AND o.observation_id = ?
             )
           ON CONFLICT(serial_number) DO UPDATE SET
             observed_at = MAX(serial_removals.observed_at, excluded.observed_at)`,
        )
        .bind(observedAt, device.device_id, serialNumber, observationId),
      db.prepare(
      `INSERT INTO device_mappings(
          cloudflare_device_id, serial_number, cortex_endpoint_id,
          hostname, verified_mac, status, created_at, updated_at,
          last_verified_at
        )
        SELECT ?, ?, ?, ?, ?, 'verified', ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM device_observations o
          WHERE o.cloudflare_device_id = ? AND o.observation_id = ?
        )
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
      serialNumber,
      endpoint.endpoint_id,
      normalizeHostname(device.hostname),
      verifiedMac,
      observedAt,
      observedAt,
      observedAt,
      device.device_id,
      observationId,
      ),
      db
        .prepare(
          `DELETE FROM serial_removals
           WHERE serial_number = ?
             AND EXISTS (
               SELECT 1 FROM device_mappings m
               WHERE m.cloudflare_device_id = ?
                 AND m.status = 'verified'
                 AND TRIM(m.serial_number) = ?
             )`,
        )
        .bind(serialNumber, device.device_id, serialNumber),
    ];
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
            operational_status = 'missing', last_content_update_time = 0,
            last_seen = 0, score = 0, reason = 'endpoint_missing',
            cortex_refreshed_at = ?, updated_at = ?
          WHERE excluded.cortex_refreshed_at >= endpoint_snapshots.cortex_refreshed_at`,
      )
      .bind(endpointId, now, now, now, now),
  );
  for (const batch of chunk(statements, 100)) await db.batch(batch);
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

export async function recordListSyncSuccess(
  db: D1Database,
  count: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO integration_status(
         name, status, message, last_success_at, updated_at
       ) VALUES ('cloudflare_serial_list', 'healthy', ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         status = excluded.status, message = excluded.message,
         last_success_at = excluded.last_success_at,
         updated_at = excluded.updated_at`,
    )
    .bind(`${count} noncompliant serials`, now, now)
    .run();
}

export async function recordListSyncError(
  db: D1Database,
  message: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO integration_status(
         name, status, message, last_error_at, updated_at
       ) VALUES ('cloudflare_serial_list', 'degraded', ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         status = excluded.status, message = excluded.message,
         last_error_at = excluded.last_error_at,
         updated_at = excluded.updated_at`,
    )
    .bind(message.slice(0, 500), now, now)
    .run();
}

export async function claimSyncLease(
  db: D1Database,
  name: string,
  now: number,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO sync_leases(name, lease_token, leased_until)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         lease_token = excluded.lease_token,
         leased_until = excluded.leased_until
       WHERE sync_leases.leased_until <= ?`,
    )
    .bind(name, token, now + 15 * 60_000, now)
    .run();
  return result.meta.changes === 1 ? token : null;
}

export async function releaseSyncLease(
  db: D1Database,
  name: string,
  token: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM sync_leases WHERE name = ? AND lease_token = ?`)
    .bind(name, token)
    .run();
}

export async function clearSerialRemovals(
  db: D1Database,
  serialNumbers: string[],
): Promise<void> {
  for (const values of chunk(serialNumbers, 80)) {
    const placeholders = values.map(() => "?").join(",");
    await db
      .prepare(
        `DELETE FROM serial_removals WHERE serial_number IN (${placeholders})`,
      )
      .bind(...values)
      .run();
  }
}

export async function releaseRefreshLeases(
  db: D1Database,
  endpointIds: string[],
  leaseToken: string,
): Promise<void> {
  for (const ids of chunk(endpointIds, 80)) {
    const placeholders = ids.map(() => "?").join(",");
    await db
      .prepare(
        `DELETE FROM refresh_leases
         WHERE lease_token = ?
           AND cortex_endpoint_id IN (${placeholders})`,
      )
      .bind(leaseToken, ...ids)
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
