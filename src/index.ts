import { authMode, AuthenticationError, validateAccessRequest } from "./auth";
import { getEndpointsByHostnames, getEndpointsByIds } from "./cortex";
import {
  listAvailableSerialLists,
  reconcileNoncompliantSerialList,
  type SerialListSyncResult,
} from "./cloudflare-list";
import { dashboardPage } from "./dashboard";
import { evaluateEndpoint, findCortexEndpoint, normalizeHostname } from "./posture";
import { ensureSchema } from "./schema";
import {
  claimDueEndpointIds,
  claimSyncLease,
  clearDebugLog,
  deleteDevices,
  getAppSettings,
  bootstrapAppSettings,
  getDashboardIntegrations,
  getDeviceComplianceByDeviceId,
  getDeviceCounts,
  getDeviceMappingsByDeviceIds,
  getSerialComplianceDecisions,
  getStoredEvaluations,
  getVerifiedMappingsByEndpointIds,
  invalidateDeviceMappings,
  listDebugLog,
  listDeviceCompliance,
  markMissingEndpoints,
  recordCortexError,
  recordCortexSuccess,
  recordListSyncError,
  recordListSyncSuccess,
  releaseRefreshLeases,
  releaseSyncLease,
  markRediscoveryAttempted,
  updateMappingEndpoint,
  saveAppSettings,
  saveDeviceObservations,
  saveDeviceMappings,
  saveEndpointSnapshots,
  updateVerifiedDeviceSerials,
} from "./repository";
import type { AppSettings, DeviceCompliance } from "./repository";
import type {
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

      await validateAccessRequest(request, env);

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
      const serialUpdates: Array<{
        deviceId: string;
        serialNumber: string | null;
      }> = [];
      let staleCount = 0;
      const staleAfter = detectionRefreshMinutes(env) * 2 * 60_000;

      for (const device of devices) {
        const stored = evaluations.get(device.device_id);
        if (!stored) {
          result[device.device_id] = { s2s_id: "", score: 0 };
          discoveries.push(device);
          continue;
        }

        const currentSerial = device.serial_number?.trim() || null;
        const storedSerial = stored.serialNumber?.trim() || null;
        // Hostname is the mapping identity; MAC only disambiguates duplicate
        // hostnames at discovery time, so a NIC change does not invalidate a
        // stored mapping.
        const identityChanged =
          normalizeHostname(device.hostname) !== stored.hostname ||
          Boolean(
            storedSerial && currentSerial && storedSerial !== currentSerial,
          );
        if (identityChanged) {
          result[device.device_id] = { s2s_id: "", score: 0 };
          invalidDeviceIds.push(device.device_id);
          discoveries.push(device);
          continue;
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
            ...serialUpdates.map((update) => update.deviceId),
          ]),
        ],
        observationId,
        observedAt,
      );

      await Promise.all([
        invalidateDeviceMappings(env.DB, invalidDeviceIds, observationId),
        updateVerifiedDeviceSerials(
          env.DB,
          serialUpdates,
          observationId,
          observedAt,
        ),
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
          stale_fail_open: staleCount,
        }),
      );

      return json({ result });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return json({ error: "forbidden" }, 403);
      }
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
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
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

  const endpoints = await getEndpointsByHostnames(hostnames, env);
  const matched = new Map<string, CortexEndpoint>();
  const mappings: Array<{
    device: CloudflareDevice;
    endpoint: CortexEndpoint;
  }> = [];
  const now = Date.now();

  for (const device of message.devices) {
    const endpoint = findCortexEndpoint(device, endpoints);
    if (!endpoint) {
      console.warn(
        JSON.stringify({
          event: "device_mapping_failed",
          cloudflare_device_id: device.device_id,
          reason: "no_unique_hostname_and_mac_match",
        }),
      );
      continue;
    }
    matched.set(endpoint.endpoint_id, endpoint);
    mappings.push({ device, endpoint });
  }

  await saveDeviceMappings(env.DB, mappings, observationId, observedAt);
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
        ...(mapping.verifiedMac
          ? { mac_address: mapping.verifiedMac }
          : {}),
      };
      const match = findCortexEndpoint(device, endpoints);
      if (!match) continue;
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
  const [integrations, devices, decisions] = await Promise.all([
    getDashboardIntegrations(env.DB),
    getDeviceCounts(env.DB),
    getSerialComplianceDecisions(
      env.DB,
      maximumAgeDays * 86_400_000,
      now - refreshMinutes * 2 * 60_000,
    ),
  ]);
  return json({
    generated_at: now,
    maximum_content_age_days: maximumAgeDays,
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
    devices,
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
    auth_mode: authMode(env),
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
  return (
    !!env.CORTEX_BASE_URL && !env.CORTEX_BASE_URL.includes("replace-")
  );
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
