import {
  getEndpointsByHostnames,
  getEndpointsByIds,
  getRecentlySeenEndpoints,
} from "./cortex";
import {
  listAvailableSerialLists,
  reconcileNoncompliantSerialList,
  type SerialListSyncResult,
} from "./cloudflare-list";
import { dashboardPage } from "./dashboard";
import {
  classifyIdentity,
  coverageSummary,
  evaluateEndpoint,
  needsMacsUnion,
  normalizeHostname,
  normalizeMacCollection,
  resolveCortexEndpoint,
} from "./posture";
import { ensureSchema } from "./schema";
import {
  claimDueEndpointIds,
  claimSyncLease,
  clearDebugLog,
  countUnboundDevices,
  deleteDevices,
  deleteStaleUnboundDevices,
  deleteUnboundDevices,
  getAppSettings,
  getAppSettingValues,
  getMappedEndpointIds,
  getStaleDeviceIds,
  bootstrapAppSettings,
  getDashboardIntegrations,
  getDeviceComplianceByDeviceId,
  getDeviceCounts,
  getDeviceMappingsByDeviceIds,
  getSerialComplianceDecisions,
  getStoredEvaluations,
  getUnboundDevice,
  getVerifiedMappingsByEndpointIds,
  invalidateDeviceMappings,
  listDebugLog,
  listDeviceCompliance,
  listDriftedBindings,
  listUnboundDevices,
  markMissingEndpoints,
  pinDeviceBinding,
  recordCortexError,
  recordCortexSuccess,
  recordListSyncError,
  recordListSyncSuccess,
  releaseRefreshLeases,
  releaseSyncLease,
  markRediscoveryAttempted,
  serialIntegrity,
  updateMappingEndpoint,
  saveAppSettings,
  saveDeviceObservations,
  saveDeviceMappings,
  saveEndpointSnapshots,
  touchDeviceLastSeen,
  touchMappingDrift,
  updateVerifiedDeviceSerials,
  updateVerifiedMacs,
  upsertUnboundDevice,
} from "./repository";
import type { AppSettings, DeviceCompliance } from "./repository";
import type {
  BindMethod,
  CloudflareDevice,
  CortexEndpoint,
  Evaluation,
  RefreshMessage,
  RuntimeEnv,
} from "./types";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_DEVICES = 1000;

let schemaEnsured = false;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (!schemaEnsured) {
        try {
          await ensureSchema(env.DB);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "request_schema_error",
              error: errorMessage(error),
            }),
          );
        } finally {
          schemaEnsured = true;
        }
      }

      // Mutating /api routes require the MANAGEMENT_TOKEN secret while it is
      // configured. /check is excluded: the Cloudflare provider calls it with
      // its own service credentials, and GET routes stay open so the
      // dashboard remains readable without a token.
      if (
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        url.pathname.startsWith("/api/")
      ) {
        const gate = await requireManagementToken(request, env);
        if (gate) return gate;
      }

      if (url.pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return await getHealth(env.DB);
      }

      if (url.pathname === "/dashboard") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return dashboardPage();
      }

      if (url.pathname === "/api/overview") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return await getApiOverview(env);
      }

      if (url.pathname === "/api/devices") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return await getApiDevices(url, env);
      }

      if (url.pathname === "/api/devices/refresh") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await postApiDeviceRefresh(request, env);
      }

      if (url.pathname === "/api/devices/delete") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await postApiDeviceDelete(request, env);
      }

      if (url.pathname === "/api/sync") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await postApiSync(env);
      }

      if (url.pathname === "/api/coverage") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await postApiCoverage(url, env);
      }

      if (url.pathname === "/api/bindings") {
        if (request.method === "GET") return await getApiBindings(env);
        if (request.method === "POST") {
          return await postApiBindings(request, env);
        }
        if (request.method === "DELETE") {
          return await deleteApiBindings(request, env);
        }
        return methodNotAllowed("GET, POST, DELETE");
      }

      if (url.pathname === "/api/debug-log") {
        if (request.method === "GET") return await getApiDebugLog(url, env);
        if (request.method === "DELETE") {
          await clearDebugLog(env.DB);
          return json({ cleared: true });
        }
        return methodNotAllowed("GET, DELETE");
      }

      if (url.pathname === "/api/settings") {
        if (request.method === "GET") return await getApiSettings(env);
        if (request.method === "PUT") return await putApiSettings(request, env);
        return methodNotAllowed("GET, PUT");
      }

      if (url.pathname === "/api/cloudflare/lists") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return await getCloudflareLists(env);
      }

      if (url.pathname !== "/check") {
        return json({ error: "not_found" }, 404);
      }
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!request.headers.get("content-type")?.includes("application/json")) {
        return json({ error: "content_type_must_be_application_json" }, 415);
      }

      const body = await readRequestJson(request, MAX_REQUEST_BYTES);
      const devices = parseDevices(body);
      const observationId = crypto.randomUUID();
      const observedAt = Date.now();
      const evaluations = await getStoredEvaluations(
        env.DB,
        devices.map((device) => device.device_id),
      );

      const result = Object.create(null) as Record<
        string,
        { s2s_id: string; score: number }
      >;
      const discoveries: CloudflareDevice[] = [];
      const missingSnapshots = new Set<string>();
      const invalidDeviceIds: string[] = [];
      const driftedDeviceIds: string[] = [];
      const macUnionUpdates: Array<{ deviceId: string; macs: string[] }> = [];
      const serialUpdates: Array<{
        deviceId: string;
        serialNumber: string | null;
      }> = [];
      const seenTouches: string[] = [];
      let staleCount = 0;
      const staleAfter = detectionRefreshMinutes(env) * 2 * 60_000;
      const touchAfter = 24 * 60 * 60_000;

      for (const device of devices) {
        const stored = evaluations.get(device.device_id);
        if (!stored) {
          result[device.device_id] = { s2s_id: "", score: 0 };
          discoveries.push(device);
          continue;
        }

        const currentSerial = device.serial_number?.trim() || null;
        const storedSerial = stored.serialNumber?.trim() || null;
        // The mapping identity is the device_id -> endpoint_id binding.
        // Hostname and MAC are drift evidence, not the key: a rename or a NIC
        // change marks the binding as drifted while the last verdict keeps
        // serving, because unbinding on drift would let a stale machine
        // escape the denylist simply by renaming itself. Only hostname and
        // MAC changing together is treated as a replacement. Serial-number
        // changes never invalidate; they flow through the silent update path
        // below so the denylist entry follows the current serial.
        const drift = classifyIdentity(device, stored);
        if (drift === "replaced") {
          result[device.device_id] = { s2s_id: "", score: 0 };
          invalidDeviceIds.push(device.device_id);
          discoveries.push(device);
          continue;
        }
        if (drift !== "confirmed") {
          driftedDeviceIds.push(device.device_id);
          // Re-run discovery for a renamed machine at most once per hour:
          // drifted_at doubles as the throttle, and every drifted poll would
          // otherwise trigger a Cortex hostname query.
          if (
            drift === "hostname_drift" &&
            (stored.driftedAt === null ||
              observedAt - stored.driftedAt >= REDISCOVERY_INTERVAL_MS)
          ) {
            discoveries.push(device);
          }
        }
        const reportedMacs = normalizeMacCollection(device.mac_address);
        if (needsMacsUnion(stored.verifiedMacs, reportedMacs)) {
          macUnionUpdates.push({
            deviceId: device.device_id,
            macs: [...new Set([...stored.verifiedMacs, ...reportedMacs])],
          });
        }

        if (!stored.lastSeenAt || observedAt - stored.lastSeenAt > touchAfter) {
          seenTouches.push(device.device_id);
        }

        if (currentSerial !== storedSerial) {
          serialUpdates.push({
            deviceId: device.device_id,
            serialNumber: currentSerial,
          });
        }

        if (stored.score === null) {
          result[device.device_id] = {
            s2s_id: stored.cortexEndpointId,
            score: 0,
          };
          missingSnapshots.add(stored.cortexEndpointId);
          continue;
        }

        if (
          !stored.cortexRefreshedAt ||
          Date.now() - stored.cortexRefreshedAt > staleAfter
        ) {
          staleCount += 1;
        }

        // Fail-open is limited to the last score of an already verified mapping.
        result[device.device_id] = {
          s2s_id: stored.cortexEndpointId,
          score: stored.score,
        };
      }

      // Observation rows exist to guard concurrent polls against stale
      // mapping writes, so they are only needed for devices that this poll
      // acts on. Keeping stable devices out of the write path keeps D1 write
      // volume proportional to fleet churn instead of fleet size.
      await saveDeviceObservations(
        env.DB,
        [
          ...new Set([
            ...discoveries.map((device) => device.device_id),
            ...invalidDeviceIds,
            ...driftedDeviceIds,
            ...macUnionUpdates.map((update) => update.deviceId),
            ...serialUpdates.map((update) => update.deviceId),
          ]),
        ],
        observationId,
        observedAt,
      );

      await Promise.all([
        invalidateDeviceMappings(env.DB, invalidDeviceIds, observationId),
        touchMappingDrift(
          env.DB,
          driftedDeviceIds,
          observationId,
          observedAt,
        ),
        updateVerifiedMacs(
          env.DB,
          macUnionUpdates,
          observationId,
          observedAt,
        ),
        updateVerifiedDeviceSerials(
          env.DB,
          serialUpdates,
          observationId,
          observedAt,
        ),
        // Provider liveness + daily per-device last-seen touch. These power
        // the dashboard's provider indicator and the stale-device cleanup.
        devices.length > 0
          ? saveAppSettings(
              env.DB,
              { last_check_at: String(observedAt) },
              observedAt,
            )
          : Promise.resolve(),
        seenTouches.length > 0
          ? touchDeviceLastSeen(env.DB, seenTouches, observedAt)
          : Promise.resolve(),
      ]);

      ctx.waitUntil(
        Promise.all([
          enqueueDiscoveries(
            env.REFRESH_QUEUE,
            discoveries,
            observationId,
            observedAt,
          ),
          enqueueRefreshes(env.REFRESH_QUEUE, [...missingSnapshots]),
        ]).catch((error: unknown) => {
          console.error(
            JSON.stringify({
              event: "posture_enqueue_error",
              error: errorMessage(error),
            }),
          );
        }),
      );

      console.log(
        JSON.stringify({
          event: "posture_batch_evaluated",
          devices: devices.length,
          mapped: evaluations.size,
          discovery_queued: discoveries.length,
          identity_drifted: driftedDeviceIds.length,
          macs_absorbed: macUnionUpdates.length,
          stale_fail_open: staleCount,
        }),
      );

      return json({ result });
    } catch (error) {
      if (error instanceof ClientError) {
        return json({ error: error.message }, error.status);
      }

      console.error(
        JSON.stringify({
          event: "posture_request_error",
          error: errorMessage(error),
        }),
      );
      return json({ error: "posture_service_error" }, 503);
    }
  },

  async scheduled(_controller, env): Promise<void> {
    try {
      await ensureSchema(env.DB);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "scheduled_schema_error",
          error: errorMessage(error),
        }),
      );
    }

    await applyBootstrapSettings(env);

    let settings: AppSettings | null = null;
    try {
      settings = await getAppSettings(env.DB);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "scheduled_settings_error",
          error: errorMessage(error),
        }),
      );
    }

    if (settings?.listSyncEnabled) {
      if (settings.cloudflareAccountId && settings.serialListId) {
        try {
          const result = await synchronizeList(env, settings);
          if (result) {
            console.log(
              JSON.stringify({
                event: "serial_denylist_synchronized",
                changed: result.changed,
                count: result.count,
              }),
            );
          }
        } catch (error) {
          const detail = errorMessage(error);
          try {
            await recordListSyncError(env.DB, detail, Date.now());
          } catch (statusError) {
            console.error(
              JSON.stringify({
                event: "serial_denylist_status_error",
                error: errorMessage(statusError),
              }),
            );
          }
          console.error(
            JSON.stringify({
              event: "serial_denylist_sync_error",
              error: detail,
            }),
          );
        }
      } else {
        const detail =
          "List synchronization is enabled but the Cloudflare account or list is not selected";
        try {
          await recordListSyncError(env.DB, detail, Date.now());
        } catch (statusError) {
          console.error(
            JSON.stringify({
              event: "serial_denylist_status_error",
              error: errorMessage(statusError),
            }),
          );
        }
        console.error(
          JSON.stringify({ event: "serial_denylist_sync_error", error: detail }),
        );
      }
    }

    // Two refresh tiers: endpoints with stale content (current denylist
    // members) are re-checked at the recovery interval so recovered devices
    // are unblocked quickly; everything else is only swept at the detection
    // interval, because a device crossing the content-age threshold is
    // detected just as well hours later.
    const recoveryMinutes = recoveryRefreshMinutes(env);
    const detectionMinutes = detectionRefreshMinutes(env);
    const maximumContentAgeDays = settings?.maxContentAgeDays ?? 7;
    const now = Date.now();
    let afterId = "";
    let queued = 0;

    try {
      while (true) {
        const claim = await claimDueEndpointIds(
          env.DB,
          maximumContentAgeDays * 86_400_000,
          now - recoveryMinutes * 60_000,
          now - detectionMinutes * 60_000,
          afterId,
          1000,
        );
        if (claim.endpointIds.length > 0) {
          await enqueueRefreshes(
            env.REFRESH_QUEUE,
            claim.endpointIds,
            claim.leaseToken,
          );
          queued += claim.endpointIds.length;
        }
        if (claim.nextAfterId === afterId) break;
        afterId = claim.nextAfterId;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "scheduled_refresh_error",
          error: errorMessage(error),
        }),
      );
    }

    console.log(JSON.stringify({ event: "scheduled_refresh", queued }));

    await runStaleDeviceCleanup(env, Date.now());
  },

  async queue(batch, env): Promise<void> {
    await ensureSchema(env.DB);
    for (const message of batch.messages) {
      if (!isRefreshMessage(message.body)) {
        // A malformed message can never succeed on retry; drop it instead of
        // cycling through the DLQ forever.
        console.error(
          JSON.stringify({ event: "queue_message_dropped", reason: "malformed" }),
        );
        message.ack();
        continue;
      }
      try {
        const runtimeEnv = requireRuntimeEnv(env);
        const calledCortex = await processRefreshMessage(message.body, runtimeEnv);
        if (calledCortex) await recordCortexSuccess(env.DB, Date.now());
        message.ack();
      } catch (error) {
        const detail = errorMessage(error);
        await recordCortexError(env.DB, detail, Date.now());
        console.error(
          JSON.stringify({ event: "cortex_refresh_error", error: detail }),
        );
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, RefreshMessage>;

function isRefreshMessage(value: unknown): value is RefreshMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "refresh") {
    return (
      Array.isArray(candidate.endpointIds) &&
      candidate.endpointIds.every((id) => typeof id === "string")
    );
  }
  if (candidate.type === "discover") {
    return Array.isArray(candidate.devices);
  }
  return false;
}

// Daily hygiene: devices that left the Cloudflare inventory stop being touched
// by /check polls, so their mappings are removed once they have not been seen
// for STALE_DEVICE_DAYS (default 30). The cleanup only runs while the
// provider is actively polling, so a dead provider integration can never wipe
// the tracking table.
async function runStaleDeviceCleanup(env: Env, now: number): Promise<void> {
  try {
    const values = await getAppSettingValues(env.DB, [
      "last_stale_cleanup_at",
      "last_check_at",
    ]);
    const lastCleanup = Number(values.get("last_stale_cleanup_at") ?? 0);
    if (now - lastCleanup < 24 * 60 * 60_000) return;

    const lastCheck = Number(values.get("last_check_at") ?? 0);
    if (!lastCheck || now - lastCheck > 24 * 60 * 60_000) return;

    const staleDays = positiveNumber(
      (env as Env & { STALE_DEVICE_DAYS?: string }).STALE_DEVICE_DAYS,
      30,
    );
    const staleBefore = now - staleDays * 86_400_000;
    const staleIds = await getStaleDeviceIds(env.DB, staleBefore, 1000);
    await deleteStaleUnboundDevices(env.DB, staleBefore);
    await saveAppSettings(
      env.DB,
      { last_stale_cleanup_at: String(now) },
      now,
    );
    if (staleIds.length === 0) return;
    await deleteDevices(env.DB, staleIds, now);
    console.log(
      JSON.stringify({
        event: "stale_device_cleanup",
        deleted: staleIds.length,
        older_than_days: staleDays,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "stale_device_cleanup_error",
        error: errorMessage(error),
      }),
    );
  }
}

async function processRefreshMessage(
  message: RefreshMessage,
  env: RuntimeEnv,
): Promise<boolean> {
  const maxContentAgeDays = await currentMaxContentAgeDays(env.DB);

  if (message.type === "refresh") {
    const endpoints = await getEndpointsByIds(message.endpointIds, env);
    const returnedIds = new Set(endpoints.map((endpoint) => endpoint.endpoint_id));
    const missingIds = message.endpointIds.filter((id) => !returnedIds.has(id));
    const now = Date.now();
    await persistEvaluatedEndpoints(endpoints, env, maxContentAgeDays, now);
    await markMissingEndpoints(env.DB, missingIds, now);
    if (missingIds.length > 0) {
      await rediscoverMissingEndpoints(missingIds, env, maxContentAgeDays, now);
    }
    if (message.leaseToken) {
      await releaseRefreshLeases(
        env.DB,
        message.endpointIds,
        message.leaseToken,
      );
    }
    return true;
  }

  if (message.type !== "discover") {
    throw new Error("Unknown queue message type");
  }

  const observedAt = message.observedAt;
  const observationId = message.observationId;
  if (
    typeof observationId !== "string" ||
    !observationId ||
    typeof observedAt !== "number" ||
    !Number.isFinite(observedAt) ||
    observedAt <= 0
  ) {
    console.warn(JSON.stringify({ event: "stale_discovery_message_dropped" }));
    return false;
  }

  const hostnames = [
    ...new Set(
      message.devices
        .map((device) => normalizeHostname(device.hostname))
        .filter(Boolean),
    ),
  ];
  if (hostnames.length === 0) return false;

  const settings = await getAppSettings(env.DB);
  const endpoints = await getEndpointsByHostnames(hostnames, env);
  const matched = new Map<string, CortexEndpoint>();
  const resolved: Array<{
    device: CloudflareDevice;
    endpoint: CortexEndpoint;
    method: BindMethod;
  }> = [];
  const now = Date.now();

  for (const device of message.devices) {
    const outcome = resolveCortexEndpoint(device, endpoints, now, {
      requireMac: settings.requireMacCorroboration,
    });
    if (outcome.status !== "bound" || !outcome.endpoint || !outcome.method) {
      console.warn(
        JSON.stringify({
          event: "device_mapping_failed",
          cloudflare_device_id: device.device_id,
          reason: outcome.status,
        }),
      );
      // no_match is an enrollment gap (Cortex has never heard of this
      // hostname) - the coverage audit reports it. Every other failure is
      // an operator decision waiting to happen, so it is tracked.
      if (outcome.status !== "no_match") {
        await upsertUnboundDevice(env.DB, device, outcome.status, now);
      }
      continue;
    }
    resolved.push({ device, endpoint: outcome.endpoint, method: outcome.method });
  }

  // Clone-contention guard: an endpoint already bound to a different device
  // that still polls is the signature of a clone (or of an enrollment that
  // inherited another machine's identity). Never share an endpoint between
  // two devices - both would inherit one posture. A claim goes stale after
  // CLAIM_WINDOW_MS so a decommissioned machine eventually releases its
  // endpoint to a legitimate new enrollment.
  const CLAIM_WINDOW_MS = 7 * 86_400_000;
  const candidateIds = [...new Set(resolved.map((r) => r.endpoint.endpoint_id))];
  const claims = candidateIds.length
    ? await getVerifiedMappingsByEndpointIds(env.DB, candidateIds)
    : [];
  const activeClaims = new Map<string, string[]>();
  for (const claim of claims) {
    const lastSeen = claim.lastSeenAt ?? 0;
    if (now - lastSeen >= CLAIM_WINDOW_MS) continue;
    const existing = activeClaims.get(claim.cortexEndpointId) ?? [];
    existing.push(claim.cloudflareDeviceId);
    activeClaims.set(claim.cortexEndpointId, existing);
  }

  const mappings: Array<{
    device: CloudflareDevice;
    endpoint: CortexEndpoint;
    method: BindMethod;
  }> = [];
  const inBatchClaims = new Map<string, number>();
  for (const entry of resolved) {
    const claimants = activeClaims.get(entry.endpoint.endpoint_id) ?? [];
    const claimedByOther = claimants.some(
      (id) => id !== entry.device.device_id,
    );
    if (claimedByOther) {
      console.warn(
        JSON.stringify({
          event: "device_mapping_failed",
          cloudflare_device_id: entry.device.device_id,
          endpoint_id: entry.endpoint.endpoint_id,
          reason: "endpoint_claimed_by_active_device",
        }),
      );
      await upsertUnboundDevice(
        env.DB,
        entry.device,
        "endpoint_claimed_by_active_device",
        now,
      );
      continue;
    }
    inBatchClaims.set(
      entry.endpoint.endpoint_id,
      (inBatchClaims.get(entry.endpoint.endpoint_id) ?? 0) + 1,
    );
    mappings.push(entry);
  }

  // Two devices in the same poll resolving to one endpoint (twin clones
  // enrolling together): neither may take it.
  const disputedIds = new Set(
    [...inBatchClaims.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id),
  );
  const bindings = mappings.filter((entry) => {
    if (disputedIds.has(entry.endpoint.endpoint_id)) {
      console.warn(
        JSON.stringify({
          event: "device_mapping_failed",
          cloudflare_device_id: entry.device.device_id,
          endpoint_id: entry.endpoint.endpoint_id,
          reason: "endpoint_disputed_in_batch",
        }),
      );
      return false;
    }
    return true;
  });

  for (const entry of bindings) {
    matched.set(entry.endpoint.endpoint_id, entry.endpoint);
  }

  // Successfully bound devices leave the operator queue; disputed twins stay
  // in it together.
  const disputedDevices = mappings
    .filter((entry) => disputedIds.has(entry.endpoint.endpoint_id))
    .map((entry) => entry.device);
  for (const device of disputedDevices) {
    await upsertUnboundDevice(
      env.DB,
      device,
      "endpoint_disputed_in_batch",
      now,
    );
  }

  await saveDeviceMappings(env.DB, bindings, observationId, observedAt);
  if (bindings.length > 0) {
    await deleteUnboundDevices(
      env.DB,
      bindings.map((entry) => entry.device.device_id),
    );
  }
  await persistEvaluatedEndpoints(
    [...matched.values()],
    env,
    maxContentAgeDays,
    now,
  );
  return true;
}

async function applyBootstrapSettings(env: Env): Promise<void> {
  const raw = (
    env as Env & { BOOTSTRAP_SETTINGS?: string }
  ).BOOTSTRAP_SETTINGS?.trim();
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error("bootstrap settings must be a JSON object");
    }
    const updates: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        updates[key] = String(value);
      }
    }
    const applied = await bootstrapAppSettings(env.DB, updates, Date.now());
    if (applied.length > 0) {
      console.log(
        JSON.stringify({
          event: "bootstrap_settings_applied",
          keys: applied.sort(),
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "bootstrap_settings_error",
        error: errorMessage(error),
      }),
    );
  }
}

const REDISCOVERY_INTERVAL_MS = 60 * 60 * 1000;

// Cortex re-registers machines with a new endpoint_id when the agent is
// reinstalled (for example after a re-image). Such endpoints surface as
// "missing" during refresh; this re-runs hostname discovery at most once per
// hour per endpoint and re-points the stored mapping when the machine came
// back with the same hostname. Decommissioned machines simply keep failing
// open at a bounded hourly retry cost.
async function rediscoverMissingEndpoints(
  missingIds: string[],
  env: RuntimeEnv,
  maxContentAgeDays: number,
  now: number,
): Promise<void> {
  try {
    const mappings = await getVerifiedMappingsByEndpointIds(env.DB, missingIds);
    const due = mappings.filter(
      (mapping) =>
        now - (mapping.rediscoveredAt ?? 0) >= REDISCOVERY_INTERVAL_MS,
    );
    if (due.length === 0) return;
    const dueEndpoints = [
      ...new Set(due.map((mapping) => mapping.cortexEndpointId)),
    ];
    await markRediscoveryAttempted(env.DB, dueEndpoints, now);

    const hostnames = [
      ...new Set(due.map((mapping) => mapping.hostname).filter(Boolean)),
    ];
    if (hostnames.length === 0) return;
    const endpoints = await getEndpointsByHostnames(hostnames, env);

    const found = new Map<string, CortexEndpoint>();
    let repointed = 0;
    for (const mapping of due) {
      const device: CloudflareDevice = {
        device_id: mapping.cloudflareDeviceId,
        hostname: mapping.hostname,
        ...(mapping.verifiedMacs.size > 0
          ? { mac_address: [...mapping.verifiedMacs] }
          : {}),
      };
      const outcome = resolveCortexEndpoint(device, endpoints, now);
      if (outcome.status !== "bound" || !outcome.endpoint) continue;
      const match = outcome.endpoint;
      // Never re-point onto an endpoint claimed by a different device that
      // still polls - that is a twin's record, not this machine's.
      if (match.endpoint_id !== mapping.cortexEndpointId) {
        const claims = await getVerifiedMappingsByEndpointIds(env.DB, [
          match.endpoint_id,
        ]);
        const claimedByOther = claims.some(
          (claim) =>
            claim.cloudflareDeviceId !== mapping.cloudflareDeviceId &&
            (claim.lastSeenAt ?? 0) > now - 7 * 86_400_000,
        );
        if (claimedByOther) {
          console.warn(
            JSON.stringify({
              event: "endpoint_repoint_rejected",
              cloudflare_device_id: mapping.cloudflareDeviceId,
              endpoint_id: match.endpoint_id,
              reason: "endpoint_claimed_by_active_device",
            }),
          );
          continue;
        }
      }
      found.set(match.endpoint_id, match);
      if (match.endpoint_id !== mapping.cortexEndpointId) {
        await updateMappingEndpoint(
          env.DB,
          mapping.cloudflareDeviceId,
          match.endpoint_id,
          now,
        );
        repointed += 1;
      }
    }
    if (found.size > 0) {
      await persistEvaluatedEndpoints(
        [...found.values()],
        env,
        maxContentAgeDays,
        now,
      );
    }
    console.log(
      JSON.stringify({
        event: "endpoint_rediscovery",
        missing: due.length,
        recovered: found.size,
        repointed,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "endpoint_rediscovery_error",
        error: errorMessage(error),
      }),
    );
  }
}

async function currentMaxContentAgeDays(db: D1Database): Promise<number> {
  try {
    return (await getAppSettings(db)).maxContentAgeDays;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "queue_settings_error",
        error: errorMessage(error),
      }),
    );
    return 7;
  }
}

async function persistEvaluatedEndpoints(
  endpoints: CortexEndpoint[],
  env: RuntimeEnv,
  maxContentAgeDays: number,
  now = Date.now(),
): Promise<void> {
  const evaluations = new Map<string, Evaluation>();

  for (const endpoint of endpoints) {
    evaluations.set(
      endpoint.endpoint_id,
      evaluateEndpoint(
        endpoint,
        now,
        maxContentAgeDays,
      ),
    );
  }
  await saveEndpointSnapshots(env.DB, endpoints, evaluations, now);
}

async function enqueueDiscoveries(
  queue: Queue<RefreshMessage>,
  devices: CloudflareDevice[],
  observationId: string,
  observedAt: number,
): Promise<void> {
  const messages = chunk(devices, 25).map((deviceBatch) => ({
    body: {
      type: "discover",
      devices: deviceBatch,
      observationId,
      observedAt,
    } satisfies RefreshMessage,
  }));
  await sendQueueMessages(queue, messages);
}

async function enqueueRefreshes(
  queue: Queue<RefreshMessage>,
  endpointIds: string[],
  leaseToken?: string,
): Promise<void> {
  const messages = chunk([...new Set(endpointIds)], 100).map((ids) => ({
    body: {
      type: "refresh",
      endpointIds: ids,
      ...(leaseToken ? { leaseToken } : {}),
    } satisfies RefreshMessage,
  }));
  await sendQueueMessages(queue, messages);
}

async function sendQueueMessages(
  queue: Queue<RefreshMessage>,
  messages: Array<{ body: RefreshMessage }>,
): Promise<void> {
  let batch: Array<{ body: RefreshMessage }> = [];
  let batchBytes = 0;

  for (const message of messages) {
    const bytes = new TextEncoder().encode(JSON.stringify(message.body)).byteLength;
    if (bytes > 120 * 1024) throw new Error("Queue message exceeds safe size");
    if (batch.length >= 100 || batchBytes + bytes > 240 * 1024) {
      await queue.sendBatch(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(message);
    batchBytes += bytes;
  }

  if (batch.length > 0) await queue.sendBatch(batch);
}

async function getHealth(db: D1Database): Promise<Response> {
  const result = await db
    .prepare(
      `SELECT name, status, message, last_success_at, last_error_at, updated_at
       FROM integration_status ORDER BY name`,
    )
    .all();
  return json({ status: "ok", integrations: result.results });
}

async function getApiOverview(env: Env): Promise<Response> {
  const now = Date.now();
  const settings = await getAppSettings(env.DB);
  const maximumAgeDays = settings.maxContentAgeDays;
  const refreshMinutes = recoveryRefreshMinutes(env);
  const [integrations, devices, decisions, providerValues, unboundCount] =
    await Promise.all([
      getDashboardIntegrations(env.DB),
      getDeviceCounts(env.DB),
      getSerialComplianceDecisions(
        env.DB,
        maximumAgeDays * 86_400_000,
        now - refreshMinutes * 2 * 60_000,
      ),
      getAppSettingValues(env.DB, ["last_check_at"]),
      countUnboundDevices(env.DB),
    ]);
  const providerLastCheckAt = Number(providerValues.get("last_check_at") ?? 0);
  return json({
    generated_at: now,
    maximum_content_age_days: maximumAgeDays,
    provider: {
      last_check_at: providerLastCheckAt || null,
      stale: !providerLastCheckAt || now - providerLastCheckAt > 30 * 60_000,
    },
    list_sync: {
      enabled: settings.listSyncEnabled,
      ready: Boolean(
        settings.cloudflareAccountId &&
          settings.serialListId &&
          cloudflareApiToken(env),
      ),
      list_id: settings.serialListId,
      list_name: settings.serialListName,
    },
    integrations,
    devices: { ...devices, unbound: unboundCount },
    noncompliant_serials: decisions.filter((decision) => decision.noncompliant)
      .length,
  });
}

async function getApiDevices(url: URL, env: Env): Promise<Response> {
  const statusParam = url.searchParams.get("status") ?? "all";
  if (
    statusParam !== "all" &&
    statusParam !== "noncompliant" &&
    statusParam !== "compliant"
  ) {
    throw new ClientError(400, "invalid_status_filter");
  }
  const limitRaw = url.searchParams.get("limit");
  let limit = 200;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
      throw new ClientError(400, "invalid_limit");
    }
    limit = parsed;
  }
  const searchRaw = url.searchParams.get("search");
  const search = searchRaw ? searchRaw.trim().toLowerCase().slice(0, 100) : "";
  const settings = await getAppSettings(env.DB);
  const devices = await listDeviceCompliance(
    env.DB,
    settings.maxContentAgeDays * 86_400_000,
    statusParam,
    limit,
    search || undefined,
  );
  return json({
    generated_at: Date.now(),
    status: statusParam,
    limit,
    devices,
  });
}

async function getApiSettings(env: Env): Promise<Response> {
  const settings = await getAppSettings(env.DB);
  return json({
    settings,
    cloudflare_api_token_configured: Boolean(cloudflareApiToken(env)),
    cortex_configured: cortexConfigured(env),
    sync_ready: Boolean(
      settings.cloudflareAccountId &&
        settings.serialListId &&
        cloudflareApiToken(env),
    ),
  });
}

async function putApiSettings(request: Request, env: Env): Promise<Response> {
  const body = await readRequestJson(request, 16 * 1024);
  const updates = parseSettingsUpdate(body);
  await saveAppSettings(env.DB, updates, Date.now());
  return json({ settings: await getAppSettings(env.DB) });
}

async function getCloudflareLists(env: Env): Promise<Response> {
  const apiToken = cloudflareApiToken(env);
  if (!apiToken) throw new ClientError(400, "cloudflare_api_token_missing");
  try {
    const accounts = await listAvailableSerialLists(apiToken);
    return json({ accounts });
  } catch (error) {
    throw new ClientError(
      502,
      `cloudflare_api_error: ${errorMessage(error)}`,
    );
  }
}

async function postApiDeviceRefresh(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readRequestJson(request, 16 * 1024);
  if (!isRecord(body)) throw new ClientError(400, "device_id_required");
  if (body.all !== undefined) {
    if (typeof body.all !== "boolean") {
      throw new ClientError(400, "invalid_all_flag");
    }
    if (!body.all) throw new ClientError(400, "device_id_required");
    // Fleet-wide manual sync: enqueue the same refresh path Cron uses for
    // every mapped endpoint. Verdicts land in the snapshots within seconds
    // and the next list sync (Cron or "Sync now") publishes them.
    const endpointIds = await getMappedEndpointIds(env.DB);
    if (endpointIds.size === 0) return json({ refresh_queued: 0 });
    await enqueueRefreshes(env.REFRESH_QUEUE, [...endpointIds]);
    console.log(
      JSON.stringify({
        event: "manual_cortex_refresh_queued",
        endpoints: endpointIds.size,
      }),
    );
    return json({ refresh_queued: endpointIds.size });
  }
  let deviceIds: string[];
  if (typeof body.deviceId === "string" && body.deviceId.trim()) {
    deviceIds = [body.deviceId.trim()];
  } else if (Array.isArray(body.deviceIds)) {
    deviceIds = [
      ...new Set(
        body.deviceIds
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
          .map((value) => value.trim()),
      ),
    ];
    if (deviceIds.length === 0) throw new ClientError(400, "device_ids_required");
    if (deviceIds.length > 100) {
      throw new ClientError(400, "maximum_100_devices");
    }
  } else {
    throw new ClientError(400, "device_id_required");
  }

  const mappings = await getDeviceMappingsByDeviceIds(env.DB, deviceIds);
  const mappingByDevice = new Map(
    mappings.map((mapping) => [
      mapping.cloudflareDeviceId,
      mapping.cortexEndpointId,
    ]),
  );
  const notFound = deviceIds.filter((id) => !mappingByDevice.has(id));
  if (deviceIds.length === 1 && notFound.length === 1) {
    throw new ClientError(404, "device_not_found");
  }

  const endpointIds = [
    ...new Set(mappings.map((mapping) => mapping.cortexEndpointId)),
  ];
  const refreshedDeviceIds: string[] = [];
  const endpointNotFound: string[] = [];
  let endpoints: CortexEndpoint[] = [];
  if (endpointIds.length > 0) {
    const runtimeEnv = requireRuntimeEnv(env);
    try {
      endpoints = await getEndpointsByIds(endpointIds, runtimeEnv);
    } catch (error) {
      await recordCortexError(env.DB, errorMessage(error), Date.now()).catch(
        () => {},
      );
      throw error;
    }
    const returnedEndpointIds = new Set(
      endpoints.map((endpoint) => endpoint.endpoint_id),
    );
    for (const [deviceId, endpointId] of mappingByDevice) {
      if (returnedEndpointIds.has(endpointId)) refreshedDeviceIds.push(deviceId);
      else endpointNotFound.push(deviceId);
    }
    if (endpoints.length > 0) {
      const maxContentAgeDays = await currentMaxContentAgeDays(env.DB);
      await persistEvaluatedEndpoints(
        endpoints,
        runtimeEnv,
        maxContentAgeDays,
      );
      await recordCortexSuccess(env.DB, Date.now()).catch(() => {});
    }
  }

  const settings = await getAppSettings(env.DB);
  const maximumContentAge = settings.maxContentAgeDays * 86_400_000;
  const devices: DeviceCompliance[] = [];
  for (const deviceId of refreshedDeviceIds) {
    const device = await getDeviceComplianceByDeviceId(
      env.DB,
      deviceId,
      maximumContentAge,
    );
    if (device) devices.push(device);
  }
  return json({ devices, notFound, endpointNotFound });
}

async function postApiDeviceDelete(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readRequestJson(request, 16 * 1024);
  if (!isRecord(body)) throw new ClientError(400, "device_id_required");
  let deviceIds: string[];
  if (typeof body.deviceId === "string" && body.deviceId.trim()) {
    deviceIds = [body.deviceId.trim()];
  } else if (Array.isArray(body.deviceIds)) {
    deviceIds = [
      ...new Set(
        body.deviceIds
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
          .map((value) => value.trim()),
      ),
    ];
    if (deviceIds.length === 0) {
      throw new ClientError(400, "device_ids_required");
    }
    if (deviceIds.length > 100) {
      throw new ClientError(400, "maximum_100_devices");
    }
  } else {
    throw new ClientError(400, "device_id_required");
  }

  const deleted = await deleteDevices(env.DB, deviceIds, Date.now());
  const deletedSet = new Set(deleted);
  const notFound = deviceIds.filter((id) => !deletedSet.has(id));
  if (deviceIds.length === 1 && notFound.length === 1) {
    throw new ClientError(404, "device_not_found");
  }
  return json({ deleted: deleted.length, notFound });
}

async function postApiSync(env: Env): Promise<Response> {
  const settings = await getAppSettings(env.DB);
  if (!settings.listSyncEnabled) {
    throw new ClientError(400, "list_sync_disabled");
  }
  if (!settings.cloudflareAccountId || !settings.serialListId) {
    throw new ClientError(400, "list_not_configured");
  }
  try {
    const result = await synchronizeList(env, settings);
    if (!result) throw new ClientError(409, "sync_already_running");
    return json({ changed: result.changed, count: result.count });
  } catch (error) {
    if (error instanceof ClientError) throw error;
    await recordListSyncError(
      env.DB,
      errorMessage(error),
      Date.now(),
    ).catch(() => {});
    throw new ClientError(502, `sync_failed: ${errorMessage(error)}`);
  }
}

// Diffs the recently seen Cortex inventory against the verified mappings in
// D1. Uncovered endpoints have no Cloudflare device: they can never be
// enforced, so they are reported for enrollment instead of being imported.
async function postApiCoverage(url: URL, env: Env): Promise<Response> {
  const runtimeEnv = requireRuntimeEnv(env);
  let windowDays = 30;
  const windowRaw = url.searchParams.get("windowDays");
  if (windowRaw !== null) {
    const parsed = Number(windowRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 90) {
      throw new ClientError(400, "invalid_window_days");
    }
    windowDays = parsed;
  }

  const { endpoints, truncated } = await getRecentlySeenEndpoints(
    runtimeEnv,
    windowDays,
  );
  const mappedEndpointIds = await getMappedEndpointIds(env.DB);
  const summary = coverageSummary(endpoints, mappedEndpointIds);
  const uncoveredSample = endpoints
    .filter((endpoint) => !mappedEndpointIds.has(endpoint.endpoint_id))
    .slice(0, 100)
    .map((endpoint) => ({
      endpoint_id: endpoint.endpoint_id,
      hostname: endpoint.endpoint_name ?? endpoint.host_name ?? null,
      operational_status: endpoint.operational_status ?? null,
      last_seen: endpoint.last_seen ?? null,
    }));

  return json({
    scanned: summary.scanned,
    covered: summary.covered,
    uncovered: summary.uncovered,
    coverage_percent: summary.coveragePercent,
    window_days: windowDays,
    truncated,
    uncovered_sample: uncoveredSample,
  });
}

// Operator queue for binding decisions: devices whose automated resolution
// failed (clone contention, ambiguity, MAC-strict refusals), bindings whose
// identity evidence drifted, and the serial integrity report. Read-only.
async function getApiBindings(env: Env): Promise<Response> {
  const [unbound, drifted, integrity] = await Promise.all([
    listUnboundDevices(env.DB, 50),
    listDriftedBindings(env.DB, 100),
    serialIntegrity(env.DB),
  ]);

  const candidatesByDevice = new Map<
    string,
    Array<Record<string, unknown>>
  >();
  let candidatesError: string | null = null;
  if (unbound.length > 0) {
    try {
      const runtimeEnv = requireRuntimeEnv(env);
      const hostnames = [
        ...new Set(unbound.map((device) => device.hostname).filter(Boolean)),
      ];
      const endpoints = await getEndpointsByHostnames(hostnames, runtimeEnv);
      const claims = await getVerifiedMappingsByEndpointIds(
        env.DB,
        endpoints.map((endpoint) => endpoint.endpoint_id),
      );
      const claimByEndpoint = new Map(
        claims.map((claim) => [claim.cortexEndpointId, claim]),
      );
      for (const device of unbound) {
        candidatesByDevice.set(
          device.cloudflareDeviceId,
          endpoints
            .filter(
              (endpoint) =>
                normalizeHostname(endpoint.endpoint_name ?? endpoint.host_name) ===
                device.hostname,
            )
            .map((endpoint) => {
              const claim = claimByEndpoint.get(endpoint.endpoint_id);
              return {
                endpoint_id: endpoint.endpoint_id,
                hostname: endpoint.endpoint_name ?? endpoint.host_name ?? null,
                mac_address: endpoint.mac_address ?? null,
                last_seen: endpoint.last_seen ?? null,
                operational_status: endpoint.operational_status ?? null,
                claimed_by:
                  claim && claim.cloudflareDeviceId !== device.cloudflareDeviceId
                    ? claim.cloudflareDeviceId
                    : null,
              };
            }),
        );
      }
    } catch (error) {
      candidatesError = errorMessage(error);
    }
  }

  return json({
    unbound: unbound.map((device) => ({
      device_id: device.cloudflareDeviceId,
      hostname: device.hostname,
      serial_number: device.serialNumber,
      mac_address: device.macAddress,
      last_attempt_at: device.lastAttemptAt,
      attempts: device.attempts,
      last_reason: device.lastReason,
      candidates: candidatesByDevice.get(device.cloudflareDeviceId) ?? [],
    })),
    unbound_candidates_error: candidatesError,
    drifted: drifted.map((device) => ({
      device_id: device.cloudflareDeviceId,
      endpoint_id: device.cortexEndpointId,
      hostname: device.hostname,
      serial_number: device.serialNumber,
      bind_method: device.bindMethod,
      drifted_at: device.driftedAt,
    })),
    serial_integrity: integrity,
  });
}

// Pin a device to a specific Cortex endpoint. A pin is a permanent operator
// decision stored in D1: automated resolution never overrides it, and it is
// immune to hostname collisions and MAC changes.
async function postApiBindings(request: Request, env: Env): Promise<Response> {
  const body = await readRequestJson(request, 16 * 1024);
  if (!isRecord(body)) throw new ClientError(400, "bindings_object_required");
  const deviceId = optionalDeviceId(body.device_id);
  const endpointId = optionalDeviceId(body.endpoint_id);

  const unbound = await getUnboundDevice(env.DB, deviceId);
  if (!unbound) throw new ClientError(404, "unbound_device_not_found");

  const runtimeEnv = requireRuntimeEnv(env);
  const endpoints = await getEndpointsByIds([endpointId], runtimeEnv);
  if (endpoints.length === 0 || endpoints[0]?.endpoint_id !== endpointId) {
    throw new ClientError(400, "unknown_endpoint");
  }

  // The same contention rule as automated resolution: never share an
  // endpoint with a different device that still polls.
  const claims = await getVerifiedMappingsByEndpointIds(env.DB, [endpointId]);
  const claimedByOther = claims.some(
    (claim) =>
      claim.cloudflareDeviceId !== deviceId &&
      (claim.lastSeenAt ?? 0) > Date.now() - 7 * 86_400_000,
  );
  if (claimedByOther) throw new ClientError(409, "endpoint_claimed_by_active_device");

  const now = Date.now();
  await pinDeviceBinding(env.DB, unbound, endpointId, now);
  await enqueueRefreshes(env.REFRESH_QUEUE, [endpointId]);
  return json({ pinned: true, device_id: deviceId, endpoint_id: endpointId });
}

// Release a device from tracking entirely: the mapping is removed, the serial
// is tombstoned for the next list sync, and the next poll starts a fresh
// discovery. Used to undo a wrong pin or drop a cloned enrollment.
async function deleteApiBindings(request: Request, env: Env): Promise<Response> {
  const body = await readRequestJson(request, 16 * 1024);
  if (!isRecord(body)) throw new ClientError(400, "bindings_object_required");
  const deviceId = optionalDeviceId(body.device_id);

  const mappings = await getDeviceMappingsByDeviceIds(env.DB, [deviceId]);
  if (mappings.length === 0) throw new ClientError(404, "device_not_found");
  await deleteDevices(env.DB, [deviceId], Date.now());
  return json({ released: true, device_id: deviceId });
}

function optionalDeviceId(value: unknown): string {
  if (typeof value !== "string") {
    throw new ClientError(400, "invalid_device_id");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new ClientError(400, "invalid_device_id");
  }
  return trimmed;
}

async function getApiDebugLog(url: URL, env: Env): Promise<Response> {
  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
      throw new ClientError(400, "invalid_limit");
    }
    limit = parsed;
  }
  const entries = await listDebugLog(env.DB, limit);
  return json({ entries });
}

async function synchronizeList(
  env: Env,
  settings: AppSettings,
): Promise<SerialListSyncResult | null> {
  if (!settings.cloudflareAccountId || !settings.serialListId) {
    throw new Error("Cloudflare list is not selected");
  }
  const leaseToken = await claimSyncLease(
    env.DB,
    "cloudflare_serial_list",
    Date.now(),
  );
  if (!leaseToken) return null;
  try {
    const result = await reconcileNoncompliantSerialList(env, {
      cloudflareAccountId: settings.cloudflareAccountId,
      serialListId: settings.serialListId,
      maxContentAgeDays: settings.maxContentAgeDays,
      listMaxItems: settings.listMaxItems,
    });
    await recordListSyncSuccess(env.DB, result.count, Date.now());
    return result;
  } finally {
    await releaseSyncLease(env.DB, "cloudflare_serial_list", leaseToken).catch(
      (error: unknown) => {
        console.error(
          JSON.stringify({
            event: "serial_denylist_lease_release_error",
            error: errorMessage(error),
          }),
        );
      },
    );
  }
}

function cloudflareApiToken(env: Env): string | null {
  return (
    (env as Env & { CLOUDFLARE_API_TOKEN?: string }).CLOUDFLARE_API_TOKEN
      ?.trim() || null
  );
}

function cortexConfigured(env: Env): boolean {
  const baseUrl = (env as Env & { CORTEX_BASE_URL?: string })
    .CORTEX_BASE_URL;
  return !!baseUrl && !baseUrl.includes("replace-");
}

const MANAGEMENT_TOKEN_HEADER = "x-management-token";

// Returns a 401 response when the request may not mutate, or null to let it
// through. When MANAGEMENT_TOKEN is unset the routes stay open, so a
// deployment remains usable without one.
async function requireManagementToken(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const expected = (
    env as Env & { MANAGEMENT_TOKEN?: string }
  ).MANAGEMENT_TOKEN?.trim();
  if (!expected) return null;
  const provided = request.headers.get(MANAGEMENT_TOKEN_HEADER);
  if (!provided) return json({ error: "management_token_required" }, 401);
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (!constantTimeEqual(providedHash, expectedHash)) {
    return json({ error: "management_token_invalid" }, 401);
  }
  return null;
}

function constantTimeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}

function parseSettingsUpdate(body: unknown): Record<string, string> {
  if (!isRecord(body)) throw new ClientError(400, "settings_object_required");
  const updates: Record<string, string> = {};

  if (body.cloudflareAccountId !== undefined) {
    const value = settingsString(body.cloudflareAccountId);
    if (value !== "" && !/^[a-f0-9]{32}$/i.test(value)) {
      throw new ClientError(400, "invalid_cloudflare_account_id");
    }
    updates.cloudflare_account_id = value;
  }
  if (body.serialListId !== undefined) {
    const value = settingsString(body.serialListId);
    if (
      value !== "" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new ClientError(400, "invalid_serial_list_id");
    }
    updates.serial_list_id = value;
  }
  if (body.serialListName !== undefined) {
    const value = settingsString(body.serialListName);
    if (value.length > 100) {
      throw new ClientError(400, "invalid_serial_list_name");
    }
    updates.serial_list_name = value;
  }
  if (body.listSyncEnabled !== undefined) {
    if (typeof body.listSyncEnabled !== "boolean") {
      throw new ClientError(400, "invalid_list_sync_enabled");
    }
    updates.list_sync_enabled = body.listSyncEnabled ? "true" : "false";
  }
  if (body.debugLogEnabled !== undefined) {
    if (typeof body.debugLogEnabled !== "boolean") {
      throw new ClientError(400, "invalid_debug_log_enabled");
    }
    updates.debug_log_enabled = body.debugLogEnabled ? "true" : "false";
  }
  if (body.requireMacCorroboration !== undefined) {
    if (typeof body.requireMacCorroboration !== "boolean") {
      throw new ClientError(400, "invalid_require_mac_corroboration");
    }
    updates.require_mac_corroboration = body.requireMacCorroboration
      ? "true"
      : "false";
  }
  if (body.maxContentAgeDays !== undefined) {
    updates.max_content_age_days = String(
      settingsInt(
        body.maxContentAgeDays,
        1,
        365,
        "invalid_max_content_age_days",
      ),
    );
  }
  if (body.listMaxItems !== undefined) {
    updates.list_max_items = String(
      settingsInt(body.listMaxItems, 1, 100_000, "invalid_list_max_items"),
    );
  }
  if (Object.keys(updates).length === 0) {
    throw new ClientError(400, "no_recognized_settings");
  }
  return updates;
}

function settingsString(value: unknown): string {
  if (typeof value !== "string") {
    throw new ClientError(400, "invalid_settings_value");
  }
  return value.trim();
}

function settingsInt(
  value: unknown,
  minimum: number,
  maximum: number,
  error: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ClientError(400, error);
  }
  return value;
}

async function readRequestJson(request: Request, maximum: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maximum) throw new ClientError(413, "request_too_large");

  const reader = request.body?.getReader();
  if (!reader) throw new ClientError(400, "request_body_required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new ClientError(413, "request_too_large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const item of chunks) {
    bytes.set(item, offset);
    offset += item.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ClientError(400, "invalid_json");
  }
}

function parseDevices(body: unknown): CloudflareDevice[] {
  let devices: unknown = null;
  if (isRecord(body) && Array.isArray(body.devices)) devices = body.devices;
  if (
    isRecord(body) &&
    isRecord(body.devices) &&
    Array.isArray(body.devices.devices)
  ) {
    devices = body.devices.devices;
  }
  if (!Array.isArray(devices)) {
    throw new ClientError(400, "devices_array_required");
  }
  if (devices.length > MAX_DEVICES) {
    throw new ClientError(400, "maximum_1000_devices");
  }

  const parsed: CloudflareDevice[] = [];
  const ids = new Set<string>();
  for (const value of devices) {
    if (!isRecord(value) || typeof value.device_id !== "string") {
      throw new ClientError(400, "invalid_device");
    }
    const deviceId = value.device_id.trim();
    if (!deviceId || deviceId.length > 128 || ids.has(deviceId)) {
      throw new ClientError(400, "invalid_or_duplicate_device_id");
    }
    ids.add(deviceId);
    parsed.push({
      device_id: deviceId,
      email: optionalString(value.email, 320),
      serial_number: optionalString(value.serial_number, 256),
      mac_address: optionalString(value.mac_address, 128),
      virtual_ipv4: optionalString(value.virtual_ipv4, 64),
      hostname: optionalString(value.hostname, 255),
    });
  }
  return parsed;
}

function optionalString(value: unknown, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new ClientError(400, "invalid_device_field");
  }
  return value;
}

function requireRuntimeEnv(env: Env): RuntimeEnv {
  const candidate = env as Env & {
    CORTEX_API_KEY?: string;
    CORTEX_API_KEY_ID?: string;
  };
  if (!candidate.CORTEX_API_KEY || !candidate.CORTEX_API_KEY_ID) {
    throw new Error("Cortex API secrets are not configured");
  }
  return candidate as RuntimeEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function recoveryRefreshMinutes(env: Env): number {
  return positiveNumber(
    (env as Env & { RECOVERY_REFRESH_MINUTES?: string })
      .RECOVERY_REFRESH_MINUTES,
    30,
  );
}

function detectionRefreshMinutes(env: Env): number {
  return positiveNumber(
    (env as Env & { DETECTION_REFRESH_MINUTES?: string })
      .DETECTION_REFRESH_MINUTES,
    240,
  );
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function methodNotAllowed(allowed: string): Response {
  return json({ error: "method_not_allowed" }, 405, { allow: allowed });
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}

class ClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
