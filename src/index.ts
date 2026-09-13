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
import { listZeroTrustDevices } from "./cloudflare-devices";
import {
  classifyIdentity,
  coverageSummary,
  evaluateEndpoint,
  matchesHostnamePattern,
  needsMacsUnion,
  normalizeHostname,
  normalizeMacCollection,
  parseHostnamePatterns,
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
  DEFAULT_CONTENT_AGE_MINUTES,
  MAX_CONTENT_AGE_MINUTES,
  MIN_CONTENT_AGE_MINUTES,
  getAppSettings,
  getAppSettingValues,
  getAllVerifiedDeviceIds,
  getMappedEndpointIds,
  getMappedMacsByHostname,
  getUnboundMacsByHostname,
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
  listUnboundDevicesDueForRetry,
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
// Deleting a device the provider reported this recently requires an explicit
// force flag. last_seen_at is touched at most once per day, so the window
// covers the full touch cadence plus a day of margin.
const RECENTLY_SEEN_DELETE_GUARD_MS = 48 * 60 * 60 * 1000;
// "Refresh all" processes the fleet inline (5 sequential Cortex calls of 100
// endpoints each, a few seconds) and publishes immediately when it fits this
// ceiling. Larger fleets fall back to the same queue Cron uses, since one
// HTTP request cannot reliably page through thousands of Cortex calls.
const SYNC_REFRESH_ALL_LIMIT = 500;

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

      if (url.pathname === "/api/devices/resync") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await postApiDevicesResync(env);
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

      // Non-persistent VDI (and any other excluded hostname pattern) never
      // enters binding: identity is unstable by construction, so discovery
      // would only churn the mapping table while cloned serials poison the
      // denylist. Excluded devices fail open and are dropped before the
      // discovery queue.
      let discoveriesToSend = discoveries;
      if (discoveries.length > 0) {
        try {
          const patterns = parseHostnamePatterns(
            (await getAppSettings(env.DB)).vdiHostnamePatterns,
          );
          if (patterns.length > 0) {
            const excluded = new Set(
              discoveries
                .filter((device) =>
                  matchesHostnamePattern(device.hostname, patterns),
                )
                .map((device) => device.device_id),
            );
            if (excluded.size > 0) {
              discoveriesToSend = discoveries.filter(
                (device) => !excluded.has(device.device_id),
              );
              console.log(
                JSON.stringify({
                  event: "vdi_devices_excluded",
                  devices: excluded.size,
                }),
              );
            }
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "vdi_exclusion_error",
              error: errorMessage(error),
            }),
          );
        }
      }

      ctx.waitUntil(
        Promise.all([
          enqueueDiscoveries(
            env.REFRESH_QUEUE,
            discoveriesToSend,
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
    const maximumContentAgeMs =
      (settings?.maxContentAgeMinutes ?? DEFAULT_CONTENT_AGE_MINUTES) * 60_000;
    const now = Date.now();
    let afterId = "";
    let queued = 0;

    try {
      while (true) {
        const claim = await claimDueEndpointIds(
          env.DB,
          maximumContentAgeMs,
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

    await cleanupGhostDevices(env, Date.now());
    await retryUnboundDevices(env, Date.now());
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

const GHOST_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Daily self-heal, Cloudflare side: cross-check every verified mapping
// against the authoritative Cloudflare device inventory. A mapping whose
// device_id is not enrolled anymore (revoked, deleted, or replaced by a
// re-enrollment with a new id - a "ghost") can never poll again, yet it
// falsely "claims" its endpoint against the clone-contention guard, which
// blocks the real, current registration from ever binding to it. Aborts
// without acting if the inventory fetch is incomplete or fails, so a
// transient Cloudflare API problem can never wipe mappings.
async function cleanupGhostDevices(env: Env, now: number): Promise<void> {
  try {
    const lastCleanup = Number(
      (await getAppSettingValues(env.DB, ["last_ghost_cleanup_at"])).get(
        "last_ghost_cleanup_at",
      ) ?? 0,
    );
    if (now - lastCleanup < GHOST_CLEANUP_INTERVAL_MS) return;

    const settings = await getAppSettings(env.DB);
    if (!settings.cloudflareAccountId) return;
    const apiToken = cloudflareApiToken(env);
    if (!apiToken) return;

    const inventory = await listZeroTrustDevices(
      apiToken,
      settings.cloudflareAccountId,
    );
    if (inventory.truncated) {
      console.error(
        JSON.stringify({
          event: "ghost_cleanup_skipped",
          reason: "inventory_truncated",
        }),
      );
      return;
    }

    const validIds = new Set(inventory.devices.map((device) => device.device_id));
    const mappedIds = await getAllVerifiedDeviceIds(env.DB);
    const ghosts = mappedIds.filter((id) => !validIds.has(id));

    await saveAppSettings(env.DB, { last_ghost_cleanup_at: String(now) }, now);
    if (ghosts.length === 0) return;

    const deleted = await deleteDevices(env.DB, ghosts, now);
    console.log(
      JSON.stringify({
        event: "ghost_devices_cleaned",
        deleted: deleted.length,
        inventory: inventory.devices.length,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({ event: "ghost_cleanup_error", error: errorMessage(error) }),
    );
  }
}

const UNBOUND_RETRY_INTERVAL_MS = 60 * 60 * 1000;

// Hourly self-heal, Cortex side: re-fetch each queued device's CURRENT
// identity from the authoritative Cloudflare inventory - not the snapshot
// captured when it first failed to bind - and re-run the exact same
// resolution ladder used at poll time. A device only binds here when real
// evidence now exists (a MAC that uniquely matches a Cortex endpoint);
// otherwise its queue entry is refreshed with the latest known attributes so
// an operator reviewing it is never looking at stale data.
async function retryUnboundDevices(env: Env, now: number): Promise<void> {
  try {
    const due = await listUnboundDevicesDueForRetry(
      env.DB,
      now - UNBOUND_RETRY_INTERVAL_MS,
      200,
    );
    if (due.length === 0) return;

    const settings = await getAppSettings(env.DB);
    let fresh = new Map<string, CloudflareDevice>();
    if (settings.cloudflareAccountId) {
      const apiToken = cloudflareApiToken(env);
      if (apiToken) {
        try {
          const inventory = await listZeroTrustDevices(
            apiToken,
            settings.cloudflareAccountId,
          );
          fresh = new Map(
            inventory.devices.map((device) => [device.device_id, device]),
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "unbound_retry_inventory_error",
              error: errorMessage(error),
            }),
          );
        }
      }
    }

    // A device no longer enrolled at all cannot bind under any evidence -
    // release it from the queue instead of retrying it forever.
    const stillEnrolled = (deviceId: string) =>
      fresh.size === 0 || fresh.has(deviceId);
    const gone = due.filter(
      (device) => !stillEnrolled(device.cloudflareDeviceId),
    );
    if (gone.length > 0) {
      await deleteUnboundDevices(
        env.DB,
        gone.map((device) => device.cloudflareDeviceId),
      );
    }

    const stillQueued = due.filter((device) =>
      stillEnrolled(device.cloudflareDeviceId),
    );
    if (stillQueued.length === 0) return;

    const devices: CloudflareDevice[] = stillQueued.map((device) => {
      const liveDevice = fresh.get(device.cloudflareDeviceId);
      if (liveDevice) return liveDevice;
      // No live inventory to compare against (account not configured, or
      // the fetch failed this cycle) - retry with the last known attributes,
      // which still catches a Cortex-side change even without a fresh
      // Cloudflare read.
      let mac: string[] | undefined;
      if (device.macAddress) {
        try {
          const parsed: unknown = JSON.parse(device.macAddress);
          if (Array.isArray(parsed)) mac = parsed as string[];
        } catch {
          mac = undefined;
        }
      }
      return {
        device_id: device.cloudflareDeviceId,
        hostname: device.hostname,
        ...(device.serialNumber ? { serial_number: device.serialNumber } : {}),
        ...(mac ? { mac_address: mac } : {}),
      };
    });

    const runtimeEnv = requireRuntimeEnv(env);
    const observationId = crypto.randomUUID();
    await saveDeviceObservations(
      env.DB,
      devices.map((device) => device.device_id),
      observationId,
      now,
    );

    const outcome = await resolveDeviceBindings(devices, runtimeEnv, settings, now);

    if (outcome.excluded.length > 0) {
      await deleteUnboundDevices(
        env.DB,
        outcome.excluded.map((device) => device.device_id),
      );
    }
    for (const { device, reason } of outcome.failed) {
      if (reason === "no_match") continue;
      await upsertUnboundDevice(env.DB, device, reason, now);
    }

    if (outcome.bindings.length > 0) {
      await saveDeviceMappings(env.DB, outcome.bindings, observationId, now);
      await deleteUnboundDevices(
        env.DB,
        outcome.bindings.map((entry) => entry.device.device_id),
      );
      const matchedEndpoints = [
        ...new Map(
          outcome.bindings.map((entry) => [entry.endpoint.endpoint_id, entry.endpoint]),
        ).values(),
      ];
      const maxContentAgeMs = await currentMaxContentAgeMs(env.DB);
      await persistEvaluatedEndpoints(
        matchedEndpoints,
        runtimeEnv,
        maxContentAgeMs,
        now,
      );
    }

    console.log(
      JSON.stringify({
        event: "unbound_devices_retried",
        checked: stillQueued.length,
        resolved: outcome.bindings.length,
        released_not_enrolled: gone.length,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({ event: "unbound_retry_error", error: errorMessage(error) }),
    );
  }
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

interface FailedResolution {
  device: CloudflareDevice;
  reason: string;
  endpointId?: string;
}

interface DeviceResolutionResult {
  bindings: Array<{
    device: CloudflareDevice;
    endpoint: CortexEndpoint;
    method: BindMethod;
  }>;
  failed: FailedResolution[];
  excluded: CloudflareDevice[];
}

// Shared resolution core for both a live discovery batch and the automated
// retry of the operator queue: MAC-first ladder, then the clone-contention
// guard, then in-batch dispute detection. Never guesses - every rejection
// carries a reason instead of a binding.
async function resolveDeviceBindings(
  devices: CloudflareDevice[],
  env: RuntimeEnv,
  settings: AppSettings,
  now: number,
): Promise<DeviceResolutionResult> {
  const exclusionPatterns = parseHostnamePatterns(settings.vdiHostnamePatterns);
  const hostnames = [
    ...new Set(
      devices.map((device) => normalizeHostname(device.hostname)).filter(Boolean),
    ),
  ];
  const endpoints =
    hostnames.length > 0 ? await getEndpointsByHostnames(hostnames, env) : [];

  const resolved: Array<{
    device: CloudflareDevice;
    endpoint: CortexEndpoint;
    method: BindMethod;
  }> = [];
  const failed: FailedResolution[] = [];
  const excluded: CloudflareDevice[] = [];

  for (const device of devices) {
    if (matchesHostnamePattern(device.hostname, exclusionPatterns)) {
      excluded.push(device);
      continue;
    }
    const outcome = resolveCortexEndpoint(device, endpoints, now, {
      requireMac: settings.requireMacCorroboration,
    });
    if (outcome.status !== "bound" || !outcome.endpoint || !outcome.method) {
      failed.push({ device, reason: outcome.status });
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

  const mappings: typeof resolved = [];
  const inBatchClaims = new Map<string, number>();
  for (const entry of resolved) {
    const claimants = activeClaims.get(entry.endpoint.endpoint_id) ?? [];
    const claimedByOther = claimants.some((id) => id !== entry.device.device_id);
    if (claimedByOther) {
      failed.push({
        device: entry.device,
        reason: "endpoint_claimed_by_active_device",
        endpointId: entry.endpoint.endpoint_id,
      });
      continue;
    }
    inBatchClaims.set(
      entry.endpoint.endpoint_id,
      (inBatchClaims.get(entry.endpoint.endpoint_id) ?? 0) + 1,
    );
    mappings.push(entry);
  }

  // Two devices in the same batch resolving to one endpoint (twin clones
  // enrolling together): neither may take it.
  const disputedIds = new Set(
    [...inBatchClaims.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  );
  const bindings: typeof resolved = [];
  for (const entry of mappings) {
    if (disputedIds.has(entry.endpoint.endpoint_id)) {
      failed.push({
        device: entry.device,
        reason: "endpoint_disputed_in_batch",
        endpointId: entry.endpoint.endpoint_id,
      });
      continue;
    }
    bindings.push(entry);
  }

  return { bindings, failed, excluded };
}

async function processRefreshMessage(
  message: RefreshMessage,
  env: RuntimeEnv,
): Promise<boolean> {
  const maxContentAgeMs = await currentMaxContentAgeMs(env.DB);

  if (message.type === "refresh") {
    const endpoints = await getEndpointsByIds(message.endpointIds, env);
    const returnedIds = new Set(endpoints.map((endpoint) => endpoint.endpoint_id));
    const missingIds = message.endpointIds.filter((id) => !returnedIds.has(id));
    const now = Date.now();
    await persistEvaluatedEndpoints(endpoints, env, maxContentAgeMs, now);
    await markMissingEndpoints(env.DB, missingIds, now);
    if (missingIds.length > 0) {
      await rediscoverMissingEndpoints(missingIds, env, maxContentAgeMs, now);
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
  const now = Date.now();
  const outcome = await resolveDeviceBindings(message.devices, env, settings, now);

  for (const { device, reason, endpointId } of outcome.failed) {
    console.warn(
      JSON.stringify({
        event: "device_mapping_failed",
        cloudflare_device_id: device.device_id,
        reason,
        ...(endpointId ? { endpoint_id: endpointId } : {}),
      }),
    );
    // no_match is an enrollment gap (Cortex has never heard of this
    // hostname) - the coverage audit reports it. Every other failure is
    // an operator decision waiting to happen, so it is tracked.
    if (reason !== "no_match") {
      await upsertUnboundDevice(env.DB, device, reason, now);
    }
  }
  if (outcome.excluded.length > 0) {
    console.log(
      JSON.stringify({ event: "vdi_devices_excluded", devices: outcome.excluded.length }),
    );
  }

  await saveDeviceMappings(env.DB, outcome.bindings, observationId, observedAt);
  if (outcome.bindings.length > 0) {
    await deleteUnboundDevices(
      env.DB,
      outcome.bindings.map((entry) => entry.device.device_id),
    );
  }
  const matchedEndpoints = [
    ...new Map(
      outcome.bindings.map((entry) => [entry.endpoint.endpoint_id, entry.endpoint]),
    ).values(),
  ];
  await persistEvaluatedEndpoints(matchedEndpoints, env, maxContentAgeMs, now);
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
  maxContentAgeMs: number,
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
        maxContentAgeMs,
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

async function currentMaxContentAgeMs(db: D1Database): Promise<number> {
  try {
    return (await getAppSettings(db)).maxContentAgeMinutes * 60_000;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "queue_settings_error",
        error: errorMessage(error),
      }),
    );
    return DEFAULT_CONTENT_AGE_MINUTES * 60_000;
  }
}

async function persistEvaluatedEndpoints(
  endpoints: CortexEndpoint[],
  env: RuntimeEnv,
  maxContentAgeMs: number,
  now = Date.now(),
): Promise<void> {
  const evaluations = new Map<string, Evaluation>();

  for (const endpoint of endpoints) {
    evaluations.set(
      endpoint.endpoint_id,
      evaluateEndpoint(
        endpoint,
        now,
        maxContentAgeMs,
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
  const maximumAgeMs = settings.maxContentAgeMinutes * 60_000;
  const refreshMinutes = recoveryRefreshMinutes(env);
  const [integrations, devices, decisions, providerValues, unboundCount] =
    await Promise.all([
      getDashboardIntegrations(env.DB),
      getDeviceCounts(env.DB),
      getSerialComplianceDecisions(
        env.DB,
        maximumAgeMs,
        now - refreshMinutes * 2 * 60_000,
      ),
      getAppSettingValues(env.DB, ["last_check_at"]),
      countUnboundDevices(env.DB),
    ]);
  const providerLastCheckAt = Number(providerValues.get("last_check_at") ?? 0);
  return json({
    generated_at: now,
    maximum_content_age_minutes: settings.maxContentAgeMinutes,
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
    settings.maxContentAgeMinutes * 60_000,
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

interface RefreshAllSummary {
  mode: "sync" | "async";
  refreshedEndpoints: number;
  refreshQueued: number;
}

// Refreshes Cortex content for every currently mapped endpoint. Fleets at or
// under SYNC_REFRESH_ALL_LIMIT are refreshed inline; larger fleets fall back
// to the same queue Cron uses. Never publishes on its own - callers decide
// when to sync, so a caller doing more work first (like a full Cloudflare
// resync) can publish once at the end instead of twice.
async function refreshMappedEndpointsCore(env: Env): Promise<RefreshAllSummary> {
  const endpointIds = [...(await getMappedEndpointIds(env.DB))];
  if (endpointIds.length === 0) {
    return { mode: "sync", refreshedEndpoints: 0, refreshQueued: 0 };
  }

  if (endpointIds.length <= SYNC_REFRESH_ALL_LIMIT) {
    const runtimeEnv = requireRuntimeEnv(env);
    let endpoints: CortexEndpoint[] = [];
    try {
      endpoints = await getEndpointsByIds(endpointIds, runtimeEnv);
    } catch (error) {
      await recordCortexError(env.DB, errorMessage(error), Date.now()).catch(
        () => {},
      );
      throw error;
    }
    if (endpoints.length > 0) {
      const maxContentAgeMs = await currentMaxContentAgeMs(env.DB);
      await persistEvaluatedEndpoints(endpoints, runtimeEnv, maxContentAgeMs);
      await recordCortexSuccess(env.DB, Date.now()).catch(() => {});
    }
    return { mode: "sync", refreshedEndpoints: endpoints.length, refreshQueued: 0 };
  }

  await enqueueRefreshes(env.REFRESH_QUEUE, endpointIds);
  return { mode: "async", refreshedEndpoints: 0, refreshQueued: endpointIds.length };
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

    const refresh = await refreshMappedEndpointsCore(env);
    let sync = {
      attempted: false,
      changed: false,
      count: null as number | null,
      error: null as string | null,
    };
    if (refresh.mode === "sync") {
      const settings = await getAppSettings(env.DB);
      sync = await attemptListSync(env, settings);
    }
    console.log(
      JSON.stringify({
        event:
          refresh.mode === "sync"
            ? "manual_cortex_refresh_all"
            : "manual_cortex_refresh_queued",
        mode: refresh.mode,
        endpoints:
          refresh.mode === "sync"
            ? refresh.refreshedEndpoints
            : refresh.refreshQueued,
        synced: sync.attempted && !sync.error,
      }),
    );
    return json({
      mode: refresh.mode,
      refreshed_endpoints: refresh.refreshedEndpoints,
      refresh_queued: refresh.refreshQueued,
      synced: sync.attempted && !sync.error,
      changed: sync.changed,
      count: sync.count,
      sync_error: sync.error,
    });
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
      const maxContentAgeMs = await currentMaxContentAgeMs(env.DB);
      await persistEvaluatedEndpoints(
        endpoints,
        runtimeEnv,
        maxContentAgeMs,
      );
      await recordCortexSuccess(env.DB, Date.now()).catch(() => {});
    }
  }

  const settings = await getAppSettings(env.DB);
  const maximumContentAge = settings.maxContentAgeMinutes * 60_000;
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

  // Deleting a device the provider still reports removes its serial from
  // the denylist on the next sync - an enforcement gap a mistyped row or a
  // misused token can silently open. Devices seen within RECENTLY_SEEN_MS
  // require an explicit force flag; offline devices delete freely, matching
  // the stale-cleanup semantics.
  if (body.force !== true) {
    const mappings = await getDeviceMappingsByDeviceIds(env.DB, deviceIds);
    const mappedIds = new Set(
      mappings.map((mapping) => mapping.cloudflareDeviceId),
    );
    const now = Date.now();
    const recentlySeen = mappings
      .filter(
        (mapping) =>
          (mapping.lastSeenAt ?? 0) > now - RECENTLY_SEEN_DELETE_GUARD_MS,
      )
      .map((mapping) => mapping.cloudflareDeviceId);
    if (recentlySeen.length > 0) {
      console.warn(
        JSON.stringify({
          event: "device_delete_rejected",
          device_ids: recentlySeen,
          known: mappedIds.size,
        }),
      );
      throw new ClientError(409, "recently_seen_delete_requires_force");
    }
  }

  const deleted = await deleteDevices(env.DB, deviceIds, Date.now());
  const deletedSet = new Set(deleted);
  const notFound = deviceIds.filter((id) => !deletedSet.has(id));
  if (deviceIds.length === 1 && notFound.length === 1) {
    throw new ClientError(404, "device_not_found");
  }
  return json({ deleted: deleted.length, notFound });
}

interface ResyncSummary {
  inventory: number;
  alreadyMapped: number;
  revokedSkipped: number;
  excluded: number;
  skippedNoHostname: number;
  discoveryQueued: number;
  truncated: boolean;
}

// Rebuild missing bindings from the Cloudflare Zero Trust device inventory.
// The provider only reports devices when they poll, so a mapping deleted
// while its device is offline can never come back through /check. This pulls
// the enrolled inventory directly and feeds every unmapped, non-excluded
// device through the same discovery queue a poll would use. Returns an
// all-zero summary rather than throwing when the account is not configured,
// so a caller doing more than just this step can proceed regardless.
async function resyncFromCloudflareCore(
  env: Env,
  settings: AppSettings,
): Promise<ResyncSummary> {
  const empty: ResyncSummary = {
    inventory: 0,
    alreadyMapped: 0,
    revokedSkipped: 0,
    excluded: 0,
    skippedNoHostname: 0,
    discoveryQueued: 0,
    truncated: false,
  };
  const apiToken = cloudflareApiToken(env);
  if (!settings.cloudflareAccountId || !apiToken) return empty;

  const inventory = await listZeroTrustDevices(
    apiToken,
    settings.cloudflareAccountId,
  );

  // Devices already bound stay untouched - resync only rebuilds what is
  // missing.
  const mapped = new Set(
    (
      await getDeviceMappingsByDeviceIds(
        env.DB,
        inventory.devices.map((device) => device.device_id),
      )
    ).map((mapping) => mapping.cloudflareDeviceId),
  );

  const patterns = parseHostnamePatterns(settings.vdiHostnamePatterns);
  let excluded = 0;
  let skippedNoHostname = 0;
  const toDiscover: CloudflareDevice[] = [];
  for (const device of inventory.devices) {
    if (mapped.has(device.device_id)) continue;
    if (matchesHostnamePattern(device.hostname, patterns)) {
      excluded += 1;
      continue;
    }
    if (!device.hostname?.trim()) {
      skippedNoHostname += 1;
      continue;
    }
    toDiscover.push(device);
  }

  if (toDiscover.length > 0) {
    const observationId = crypto.randomUUID();
    const observedAt = Date.now();
    await saveDeviceObservations(
      env.DB,
      toDiscover.map((device) => device.device_id),
      observationId,
      observedAt,
    );
    await enqueueDiscoveries(
      env.REFRESH_QUEUE,
      toDiscover,
      observationId,
      observedAt,
    );
  }

  return {
    inventory: inventory.devices.length,
    alreadyMapped: mapped.size,
    revokedSkipped: inventory.revoked,
    excluded,
    skippedNoHostname,
    discoveryQueued: toDiscover.length,
    truncated: inventory.truncated,
  };
}

async function postApiDevicesResync(env: Env): Promise<Response> {
  const settings = await getAppSettings(env.DB);
  if (!settings.cloudflareAccountId) {
    throw new ClientError(400, "cloudflare_account_not_configured");
  }
  if (!cloudflareApiToken(env)) {
    throw new ClientError(400, "cloudflare_api_token_missing");
  }
  const summary = await resyncFromCloudflareCore(env, settings);
  console.log(
    JSON.stringify({
      event: "manual_cloudflare_resync",
      inventory: summary.inventory,
      queued: summary.discoveryQueued,
    }),
  );
  return json({
    inventory: summary.inventory,
    already_mapped: summary.alreadyMapped,
    revoked_skipped: summary.revokedSkipped,
    excluded: summary.excluded,
    skipped_no_hostname: summary.skippedNoHostname,
    discovery_queued: summary.discoveryQueued,
    truncated: summary.truncated,
  });
}

// Best-effort list sync shared by the explicit "Sync now" endpoint and any
// action that wants to publish immediately after changing snapshot data.
// Never throws: a misconfigured or already-running sync is reported in the
// result rather than failing the caller's primary action.
async function attemptListSync(
  env: Env,
  settings: AppSettings,
): Promise<{
  attempted: boolean;
  changed: boolean;
  count: number | null;
  error: string | null;
}> {
  if (
    !settings.listSyncEnabled ||
    !settings.cloudflareAccountId ||
    !settings.serialListId
  ) {
    return { attempted: false, changed: false, count: null, error: null };
  }
  try {
    const result = await synchronizeList(env, settings);
    if (!result) {
      return {
        attempted: true,
        changed: false,
        count: null,
        error: "sync_already_running",
      };
    }
    return {
      attempted: true,
      changed: result.changed,
      count: result.count,
      error: null,
    };
  } catch (error) {
    const detail = errorMessage(error);
    await recordListSyncError(env.DB, detail, Date.now()).catch(() => {});
    return { attempted: true, changed: false, count: null, error: detail };
  }
}

// The one comprehensive "make everything correct and up to date" action:
// rebuild any missing bindings from the Cloudflare inventory, refresh Cortex
// content for everything already mapped, then publish. Each step is
// best-effort on its own (a Cloudflare or Cortex hiccup is reported but
// never blocks the next step), so the final publish always reflects the
// most current state the Worker could gather in this one call.
async function postApiSync(env: Env): Promise<Response> {
  const settings = await getAppSettings(env.DB);
  if (!settings.listSyncEnabled) {
    throw new ClientError(400, "list_sync_disabled");
  }
  if (!settings.cloudflareAccountId || !settings.serialListId) {
    throw new ClientError(400, "list_not_configured");
  }

  let resync: ResyncSummary;
  let resyncError: string | null = null;
  try {
    resync = await resyncFromCloudflareCore(env, settings);
  } catch (error) {
    resyncError = errorMessage(error);
    resync = {
      inventory: 0,
      alreadyMapped: 0,
      revokedSkipped: 0,
      excluded: 0,
      skippedNoHostname: 0,
      discoveryQueued: 0,
      truncated: false,
    };
  }
  console.log(
    JSON.stringify({
      event: "manual_cloudflare_resync",
      inventory: resync.inventory,
      queued: resync.discoveryQueued,
      error: resyncError,
    }),
  );

  let refresh: RefreshAllSummary;
  let refreshError: string | null = null;
  try {
    refresh = await refreshMappedEndpointsCore(env);
  } catch (error) {
    refreshError = errorMessage(error);
    refresh = { mode: "sync", refreshedEndpoints: 0, refreshQueued: 0 };
  }
  console.log(
    JSON.stringify({
      event: "manual_cortex_refresh_all",
      mode: refresh.mode,
      endpoints:
        refresh.mode === "sync" ? refresh.refreshedEndpoints : refresh.refreshQueued,
      error: refreshError,
    }),
  );

  const result = await attemptListSync(env, settings);
  if (result.error === "sync_already_running") {
    throw new ClientError(409, "sync_already_running");
  }
  if (result.error) {
    throw new ClientError(502, `sync_failed: ${result.error}`);
  }
  return json({
    resync: {
      inventory: resync.inventory,
      already_mapped: resync.alreadyMapped,
      revoked_skipped: resync.revokedSkipped,
      excluded: resync.excluded,
      skipped_no_hostname: resync.skippedNoHostname,
      discovery_queued: resync.discoveryQueued,
      truncated: resync.truncated,
      error: resyncError,
    },
    refresh: {
      mode: refresh.mode,
      refreshed_endpoints: refresh.refreshedEndpoints,
      refresh_queued: refresh.refreshQueued,
      error: refreshError,
    },
    changed: result.changed,
    count: result.count,
  });
}

// Diffs the recently seen Cortex inventory against the verified mappings in
// D1. Uncovered endpoints have no Cloudflare device: they can never be
// enforced, so they are reported for enrollment instead of being imported.
// Each uncovered entry is also diagnosed, but hostname alone never proves
// two records are the same machine - a clone VM can report an identical
// hostname while being different hardware. A hostname collision with an
// already-mapped or already-queued device is only called a duplicate when
// the MACs actually corroborate; otherwise it is reported as a genuinely
// ambiguous collision instead of being waved off.
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
  const [mappedEndpointIds, mappedMacsByHostname, unboundMacsByHostname] =
    await Promise.all([
      getMappedEndpointIds(env.DB),
      getMappedMacsByHostname(env.DB),
      getUnboundMacsByHostname(env.DB),
    ]);
  const macsIntersect = (a: Set<string> | undefined, b: Set<string>) => {
    if (!a || a.size === 0 || b.size === 0) return false;
    for (const mac of b) {
      if (a.has(mac)) return true;
    }
    return false;
  };
  const summary = coverageSummary(endpoints, mappedEndpointIds);
  const uncoveredSample = endpoints
    .filter((endpoint) => !mappedEndpointIds.has(endpoint.endpoint_id))
    .slice(0, 100)
    .map((endpoint) => {
      const hostname = normalizeHostname(
        endpoint.endpoint_name ?? endpoint.host_name,
      );
      const endpointMacs = normalizeMacCollection(endpoint.mac_address);
      const mappedMacs = hostname ? mappedMacsByHostname.get(hostname) : undefined;
      const unboundMacs = hostname ? unboundMacsByHostname.get(hostname) : undefined;
      let reason: string;
      let fix: string;
      if (macsIntersect(mappedMacs, endpointMacs)) {
        reason = "duplicate_of_mapped_device";
        fix =
          "MAC-corroborated: this Cortex endpoint is the same physical machine as an already-mapped Cloudflare device (typically a Cortex agent reinstall). Safe to ignore, or run Sync now to let stale-endpoint cleanup catch up.";
      } else if (macsIntersect(unboundMacs, endpointMacs)) {
        reason = "queued_for_operator_review";
        fix =
          "MAC-corroborated match with a device already waiting in the operator queue. Review it with GET /api/bindings.";
      } else if (
        (hostname && mappedMacsByHostname.has(hostname)) ||
        (hostname && unboundMacsByHostname.has(hostname))
      ) {
        reason = "ambiguous_hostname_shared_by_multiple_devices";
        fix =
          "This hostname is shared by another device, but none of their MAC addresses match this Cortex endpoint - do not assume it is the same machine. This may be a clone VM or naming collision that needs its own Cloudflare enrollment, or the same machine's Cloudflare MAC has changed without Cortex reporting it yet. Check GET /api/bindings and verify in your VM or MDM inventory.";
      } else {
        reason = "no_cloudflare_device";
        fix =
          "No Cloudflare device with this hostname is mapped or queued. Verify the Cloudflare One Client is installed and enrolled on this machine, and that its reported hostname matches.";
      }
      return {
        endpoint_id: endpoint.endpoint_id,
        hostname: endpoint.endpoint_name ?? endpoint.host_name ?? null,
        operational_status: endpoint.operational_status ?? null,
        last_seen: endpoint.last_seen ?? null,
        reason,
        fix,
      };
    });

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
// discovery. Used to undo a wrong pin or drop a cloned enrollment. Devices
// still reporting to the provider require force, exactly like device deletion.
async function deleteApiBindings(request: Request, env: Env): Promise<Response> {
  const body = await readRequestJson(request, 16 * 1024);
  if (!isRecord(body)) throw new ClientError(400, "bindings_object_required");
  const deviceId = optionalDeviceId(body.device_id);

  const mappings = await getDeviceMappingsByDeviceIds(env.DB, [deviceId]);
  if (mappings.length === 0) throw new ClientError(404, "device_not_found");
  const lastSeen = mappings[0]?.lastSeenAt ?? 0;
  if (
    body.force !== true &&
    lastSeen > Date.now() - RECENTLY_SEEN_DELETE_GUARD_MS
  ) {
    console.warn(
      JSON.stringify({
        event: "device_delete_rejected",
        device_ids: [deviceId],
        known: 1,
      }),
    );
    throw new ClientError(409, "recently_seen_delete_requires_force");
  }
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
      maxContentAgeMs: settings.maxContentAgeMinutes * 60_000,
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
  if (body.vdiHostnamePatterns !== undefined) {
    if (typeof body.vdiHostnamePatterns !== "string") {
      throw new ClientError(400, "invalid_vdi_hostname_patterns");
    }
    const patterns = parseHostnamePatterns(body.vdiHostnamePatterns);
    if (patterns.join(",").length > 500) {
      throw new ClientError(400, "invalid_vdi_hostname_patterns");
    }
    updates.vdi_hostname_patterns = patterns.join(",");
  }
  if (body.maxContentAgeMinutes !== undefined) {
    updates.max_content_age_minutes = String(
      settingsInt(
        body.maxContentAgeMinutes,
        MIN_CONTENT_AGE_MINUTES,
        MAX_CONTENT_AGE_MINUTES,
        "invalid_max_content_age_minutes",
      ),
    );
  } else if (body.maxContentAgeDays !== undefined) {
    // Legacy whole-day input, still accepted for existing callers: convert
    // to the canonical minutes value on write.
    const days = settingsInt(
      body.maxContentAgeDays,
      1,
      365,
      "invalid_max_content_age_days",
    );
    updates.max_content_age_minutes = String(days * 1440);
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
