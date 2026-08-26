import type { CortexEndpoint, RuntimeEnv } from "./types";

interface CortexReply {
  reply?: {
    total_count?: number;
    result_count?: number;
    endpoints?: CortexEndpoint[];
    err_msg?: string;
    err_extra?: string;
  };
}

const ENDPOINT_PATH = "/public_api/v1/endpoints/get_endpoint";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function getEndpointsByIds(
  endpointIds: string[],
  env: RuntimeEnv,
): Promise<CortexEndpoint[]> {
  const endpoints: CortexEndpoint[] = [];
  for (const ids of chunk(endpointIds, 100)) {
    const response = await callCortex(
      {
        request_data: {
          filters: [
            { field: "endpoint_id_list", operator: "in", value: ids },
          ],
          search_from: 0,
          search_to: 100,
          sort: { field: "last_seen", keyword: "DESC" },
        },
      },
      env,
    );
    endpoints.push(...(response.reply?.endpoints ?? []));
  }
  return endpoints;
}

export async function getEndpointsByHostnames(
  hostnames: string[],
  env: RuntimeEnv,
): Promise<CortexEndpoint[]> {
  const unique = new Map<string, CortexEndpoint>();

  for (const names of chunk(hostnames, 10)) {
    let searchFrom = 0;
    for (let page = 0; ; page += 1) {
      if (page >= 100) {
        throw new Error("Cortex hostname search exceeded pagination safety limit");
      }
      const response = await callCortex(
        {
          request_data: {
            filters: [{ field: "hostname", operator: "in", value: names }],
            search_from: searchFrom,
            search_to: searchFrom + 100,
            sort: { field: "last_seen", keyword: "DESC" },
          },
        },
        env,
      );
      const reply = response.reply;
      const pageEndpoints = reply?.endpoints ?? [];
      for (const endpoint of pageEndpoints) {
        if (endpoint.endpoint_id) unique.set(endpoint.endpoint_id, endpoint);
      }

      const total = Number(reply?.total_count ?? 0);
      if (
        pageEndpoints.length === 0 ||
        searchFrom + pageEndpoints.length >= total
      ) {
        break;
      }
      searchFrom += pageEndpoints.length;
    }
  }

  return [...unique.values()];
}

async function callCortex(body: unknown, env: RuntimeEnv): Promise<CortexReply> {
  requireCortexConfiguration(env);
  const timeoutMs = positiveNumber(env.CORTEX_TIMEOUT_MS, 15_000);
  const baseUrl = new URL(env.CORTEX_BASE_URL);
  const url = new URL(ENDPOINT_PATH, `${baseUrl.origin}/`).toString();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: await createCortexHeaders(env),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(attempt * 500);
      continue;
    }

    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      await sleep(retryAfter > 0 ? retryAfter * 1000 : attempt * 500);
      continue;
    }

    const parsed = await readJson<CortexReply>(response, MAX_RESPONSE_BYTES);
    if (!response.ok) {
      const message =
        parsed.reply?.err_msg ??
        parsed.reply?.err_extra ??
        `HTTP ${response.status}`;
      throw new Error(`Cortex API request failed: ${message}`);
    }
    if (!parsed.reply || !Array.isArray(parsed.reply.endpoints)) {
      throw new Error("Cortex API returned an invalid endpoint response");
    }
    return parsed;
  }

  throw new Error("Cortex API retry limit reached");
}

async function createCortexHeaders(
  env: RuntimeEnv,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept-encoding": "gzip",
    "x-xdr-auth-id": env.CORTEX_API_KEY_ID,
  };

  if (env.CORTEX_KEY_TYPE.toLowerCase() !== "advanced") {
    headers.authorization = env.CORTEX_API_KEY;
    return headers;
  }

  const nonce = createAdvancedNonce();
  const timestamp = String(Date.now());
  headers["x-xdr-nonce"] = nonce;
  headers["x-xdr-timestamp"] = timestamp;
  headers.authorization = await sha256Hex(
    `${env.CORTEX_API_KEY}${nonce}${timestamp}`,
  );
  return headers;
}

function createAdvancedNonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readJson<T>(response: Response, maximum: number): Promise<T> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximum) throw new Error("Cortex response is too large");

  const reader = response.body?.getReader();
  if (!reader) return {} as T;
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("Cortex response is too large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const item of chunks) {
    body.set(item, offset);
    offset += item.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new Error(`Cortex returned invalid JSON (${response.status})`);
  }
}

function requireCortexConfiguration(env: RuntimeEnv): void {
  if (
    !env.CORTEX_BASE_URL ||
    env.CORTEX_BASE_URL.includes("replace-") ||
    !env.CORTEX_API_KEY ||
    !env.CORTEX_API_KEY_ID
  ) {
    throw new Error("Cortex API is not configured");
  }

  const baseUrl = new URL(env.CORTEX_BASE_URL);
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    (baseUrl.pathname !== "/" && baseUrl.pathname !== "") ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("Cortex base URL must be an HTTPS origin");
  }
  if (!["standard", "advanced"].includes(env.CORTEX_KEY_TYPE.toLowerCase())) {
    throw new Error("Cortex key type must be standard or advanced");
  }
}

function positiveNumber(value: string, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
