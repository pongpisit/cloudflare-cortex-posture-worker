import { AuthenticationError, validateAccessRequest } from "./auth";
import { getEndpointsByHostnames, getEndpointsByIds } from "./cortex";
import {
  evaluateExternalRequest,
  getExternalEvaluationKeys,
} from "./external-evaluation";
import { evaluateEndpoint, findCortexEndpoint, normalizeHostname } from "./posture";
import {
  claimDueEndpointIds,
  getStoredEvaluations,
  invalidateDeviceMappings,
  markMissingEndpoints,
  recordCortexError,
  recordCortexSuccess,
  saveDeviceObservations,
  saveDeviceMappings,
  saveEndpointSnapshots,
  updateDeviceVirtualIps,
} from "./repository";
import type {
  CloudflareDevice,
  CortexEndpoint,
  Evaluation,
  RefreshMessage,
  RuntimeEnv,
} from "./types";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_DEVICES = 1000;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/external-evaluation/keys") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return getExternalEvaluationKeys(env);
      }

      if (url.pathname === "/external-evaluation") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const body = await readRequestJson(request, 16 * 1024);
        return evaluateExternalRequest(body, env);
      }

      await validateAccessRequest(request, env);

      if (url.pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return getHealth(env.DB);
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
      await saveDeviceObservations(
        env.DB,
        devices.map((device) => device.device_id),
        observationId,
        observedAt,
      );
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
      const verifiedVirtualIps: Array<{
        deviceId: string;
        virtualIpv4: string | null;
      }> = [];
      const invalidDeviceIds: string[] = [];
      let staleCount = 0;
      const staleAfter =
        positiveNumber(env.SNAPSHOT_REFRESH_MINUTES, 5) * 2 * 60_000;

      for (const device of devices) {
        const stored = evaluations.get(device.device_id);
        if (!stored) {
          result[device.device_id] = { s2s_id: "", score: 0 };
          discoveries.push(device);
          continue;
        }

        const currentMacs = normalizeDeviceMacs(device.mac_address);
        const identityChanged =
          normalizeHostname(device.hostname) !== stored.hostname ||
          !currentMacs.has(stored.verifiedMac) ||
          Boolean(
            stored.serialNumber &&
              device.serial_number &&
              stored.serialNumber !== device.serial_number,
          );
        if (identityChanged) {
          result[device.device_id] = { s2s_id: "", score: 0 };
          invalidDeviceIds.push(device.device_id);
          discoveries.push(device);
          continue;
        }

        verifiedVirtualIps.push({
          deviceId: device.device_id,
          virtualIpv4: device.virtual_ipv4 ?? null,
        });

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

      await Promise.all([
        invalidateDeviceMappings(env.DB, invalidDeviceIds, observationId),
        updateDeviceVirtualIps(env.DB, verifiedVirtualIps, observationId),
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
    const refreshMinutes = positiveNumber(env.SNAPSHOT_REFRESH_MINUTES, 5);
    const cutoff = Date.now() - refreshMinutes * 60_000;
    let afterId = "";
    let queued = 0;

    while (true) {
      const endpointIds = await claimDueEndpointIds(
        env.DB,
        cutoff,
        afterId,
        1000,
      );
      if (endpointIds.length === 0) break;
      await enqueueRefreshes(env.REFRESH_QUEUE, endpointIds);
      queued += endpointIds.length;
      afterId = endpointIds.at(-1) ?? afterId;
      if (endpointIds.length < 1000) break;
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
  if (message.type === "refresh") {
    const endpoints = await getEndpointsByIds(message.endpointIds, env);
    const returnedIds = new Set(endpoints.map((endpoint) => endpoint.endpoint_id));
    const missingIds = message.endpointIds.filter((id) => !returnedIds.has(id));
    const now = Date.now();
    await persistEvaluatedEndpoints(endpoints, env, now);
    await markMissingEndpoints(env.DB, missingIds, now);
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
  await persistEvaluatedEndpoints([...matched.values()], env, now);
  return true;
}

async function persistEvaluatedEndpoints(
  endpoints: CortexEndpoint[],
  env: RuntimeEnv,
  now = Date.now(),
): Promise<void> {
  const maxContentAgeDays = positiveNumber(env.MAX_CONTENT_AGE_DAYS, 7);
  const maxLastSeenMinutes = nonNegativeNumber(env.MAX_LAST_SEEN_MINUTES, 0);
  const evaluations = new Map<string, Evaluation>();

  for (const endpoint of endpoints) {
    evaluations.set(
      endpoint.endpoint_id,
      evaluateEndpoint(
        endpoint,
        now,
        maxContentAgeDays,
        maxLastSeenMinutes,
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
): Promise<void> {
  const messages = chunk([...new Set(endpointIds)], 100).map((ids) => ({
    body: { type: "refresh", endpointIds: ids } satisfies RefreshMessage,
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
  const row = await db
    .prepare(
      `SELECT status, last_success_at, last_error_at, updated_at
       FROM integration_status WHERE name = 'cortex'`,
    )
    .first();
  return json({ status: "ok", cortex: row ?? { status: "unknown" } });
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

function normalizeDeviceMacs(value: unknown): Set<string> {
  const values = Array.isArray(value) ? value : [value];
  return new Set(
    values
      .map((item) => String(item ?? "").toLowerCase().replace(/[^0-9a-f]/g, ""))
      .filter((item) => item.length === 12),
  );
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

function positiveNumber(value: string, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value: string, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
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
