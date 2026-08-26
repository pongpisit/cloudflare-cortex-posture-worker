import {
  clearSerialRemovals,
  getSerialComplianceDecisions,
  type SerialComplianceDecision,
} from "./repository";

const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const EMPTY_LIST_SENTINEL = "__cortex_no_noncompliant_devices__";

interface ListItem {
  value?: string;
}

interface ZeroTrustList {
  id?: string;
  name?: string;
  type?: string;
  count?: number;
  items?: ListItem[];
}

interface CloudflareReply {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: ZeroTrustList;
}

export interface SerialListEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_SERIAL_LIST_ID: string;
  CLOUDFLARE_SERIAL_LIST_NAME: string;
  CLOUDFLARE_LIST_MAX_ITEMS: string;
  MAX_CONTENT_AGE_DAYS: string;
  SNAPSHOT_REFRESH_MINUTES: string;
  DB: D1Database;
  CLOUDFLARE_API_TOKEN?: string;
}

export interface SerialListSyncResult {
  changed: boolean;
  count: number;
}

export async function reconcileNoncompliantSerialList(
  env: SerialListEnv,
  now = Date.now(),
): Promise<SerialListSyncResult> {
  requireConfiguration(env);
  const maximumAgeDays = positiveNumber(env.MAX_CONTENT_AGE_DAYS, 7);
  const refreshMinutes = positiveNumber(env.SNAPSHOT_REFRESH_MINUTES, 5);
  const maximumAge = maximumAgeDays * 86_400_000;
  const refreshedAfter = now - refreshMinutes * 2 * 60_000;
  let decisions = await getSerialComplianceDecisions(
    env.DB,
    maximumAge,
    refreshedAfter,
  );
  let result: SerialListSyncResult = { changed: false, count: 0 };
  let stable = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentResult = await syncSerialList(decisions, env);
    result = {
      changed: result.changed || currentResult.changed,
      count: currentResult.count,
    };
    const latest = await getSerialComplianceDecisions(
      env.DB,
      maximumAge,
      refreshedAfter,
    );
    if (sameDecisions(decisions, latest)) {
      stable = true;
      break;
    }
    decisions = latest;
  }
  if (!stable) {
    throw new Error("Serial compliance decisions changed during synchronization");
  }
  await clearSerialRemovals(
    env.DB,
    decisions
      .filter((decision) => !decision.noncompliant)
      .map((decision) => decision.serialNumber),
  );
  return result;
}

export async function syncSerialList(
  decisions: SerialComplianceDecision[],
  env: Omit<
    SerialListEnv,
    "DB" | "MAX_CONTENT_AGE_DAYS" | "SNAPSHOT_REFRESH_MINUTES"
  >,
): Promise<SerialListSyncResult> {
  requireConfiguration(env);
  const current = await getList(env);
  const currentItems = listItems(current).filter(
    (value) => value !== EMPTY_LIST_SENTINEL,
  );
  const desired = new Set(currentItems);
  for (const decision of decisions) {
    const serial = decision.serialNumber.trim();
    if (!serial) continue;
    if (decision.noncompliant) desired.add(serial);
    else desired.delete(serial);
  }
  const serials = [...desired].sort();
  const maximumItems = positiveInteger(env.CLOUDFLARE_LIST_MAX_ITEMS, 1000);
  if (serials.length > maximumItems) {
    throw new Error(
      `Noncompliant serial count ${serials.length} exceeds configured list limit ${maximumItems}`,
    );
  }
  if (serials.length >= Math.floor(maximumItems * 0.8)) {
    console.warn(
      JSON.stringify({
        event: "serial_denylist_capacity_warning",
        count: serials.length,
        maximum: maximumItems,
      }),
    );
  }

  const desiredItems = serials.length > 0 ? serials : [EMPTY_LIST_SENTINEL];
  if (sameValues(listItems(current), desiredItems)) {
    return { changed: false, count: serials.length };
  }

  await callCloudflare(env, "PUT", {
    name: env.CLOUDFLARE_SERIAL_LIST_NAME,
    description: "Cortex endpoints with stale security content; managed by Worker",
    items: desiredItems.map((value) => ({ value })),
  });
  const verified = await getList(env);
  if (!sameValues(listItems(verified), desiredItems)) {
    throw new Error("Cloudflare serial list verification failed");
  }
  return { changed: true, count: serials.length };
}

async function getList(
  env: Omit<
    SerialListEnv,
    "DB" | "MAX_CONTENT_AGE_DAYS" | "SNAPSHOT_REFRESH_MINUTES"
  >,
): Promise<ZeroTrustList> {
  const list = await callCloudflare(env, "GET");
  validateList(list, env);
  if (!Array.isArray(list.items)) {
    list.items = await callCloudflareItems(env);
  }
  return list;
}

async function callCloudflareItems(
  env: Omit<
    SerialListEnv,
    "DB" | "MAX_CONTENT_AGE_DAYS" | "SNAPSHOT_REFRESH_MINUTES"
  >,
): Promise<ListItem[]> {
  const url = `${API_BASE_URL}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/gateway/lists/${encodeURIComponent(env.CLOUDFLARE_SERIAL_LIST_ID)}/items`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await response.body?.cancel();
      await sleep(attempt * 500);
      continue;
    }
    const parsed = await readJson<{
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: ListItem[];
    }>(response, MAX_RESPONSE_BYTES);
    if (!response.ok || parsed.success !== true || !Array.isArray(parsed.result)) {
      const detail = parsed.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new Error(`Cloudflare Zero Trust list items request failed: ${detail}`);
    }
    return parsed.result;
  }
  throw new Error("Cloudflare Zero Trust list items retry limit reached");
}

async function callCloudflare(
  env: Omit<
    SerialListEnv,
    "DB" | "MAX_CONTENT_AGE_DAYS" | "SNAPSHOT_REFRESH_MINUTES"
  >,
  method: "GET" | "PUT",
  body?: unknown,
): Promise<ZeroTrustList> {
  const url = `${API_BASE_URL}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/gateway/lists/${encodeURIComponent(env.CLOUDFLARE_SERIAL_LIST_ID)}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(
      url,
      method === "GET"
        ? {
            method: "GET",
            headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
            signal: AbortSignal.timeout(15_000),
          }
        : {
            method: "PUT",
            headers: {
              authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
          },
    );
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await response.body?.cancel();
      await sleep(attempt * 500);
      continue;
    }

    const parsed = await readJson<CloudflareReply>(response, MAX_RESPONSE_BYTES);
    if (
      !response.ok ||
      parsed.success !== true ||
      (method === "GET" && !parsed.result)
    ) {
      const detail = parsed.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new Error(`Cloudflare Zero Trust list request failed: ${detail}`);
    }
    return parsed.result ?? {};
  }
  throw new Error("Cloudflare Zero Trust list retry limit reached");
}

function validateList(
  list: ZeroTrustList,
  env: Omit<
    SerialListEnv,
    "DB" | "MAX_CONTENT_AGE_DAYS" | "SNAPSHOT_REFRESH_MINUTES"
  >,
): void {
  if (list.id !== env.CLOUDFLARE_SERIAL_LIST_ID) {
    throw new Error("Cloudflare returned an unexpected Zero Trust list");
  }
  if (list.type !== "SERIAL") {
    throw new Error("Configured Zero Trust list must have type SERIAL");
  }
  if (list.name !== env.CLOUDFLARE_SERIAL_LIST_NAME) {
    throw new Error("Configured Zero Trust list name does not match");
  }
}

function listItems(list: ZeroTrustList): string[] {
  if (!Array.isArray(list.items)) {
    throw new Error("Cloudflare Zero Trust list response did not include items");
  }
  return normalizeSerials(list.items.map((item) => item.value ?? ""));
}

function requireConfiguration(
  env: Omit<
    SerialListEnv,
    "DB" | "MAX_CONTENT_AGE_DAYS" | "SNAPSHOT_REFRESH_MINUTES"
  >,
): void {
  if (
    !env.CLOUDFLARE_ACCOUNT_ID ||
    !env.CLOUDFLARE_SERIAL_LIST_ID ||
    env.CLOUDFLARE_SERIAL_LIST_ID.startsWith("replace-") ||
    !env.CLOUDFLARE_SERIAL_LIST_NAME ||
    !env.CLOUDFLARE_API_TOKEN
  ) {
    throw new Error("Cloudflare serial list synchronization is not configured");
  }
}

function normalizeSerials(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDecisions(
  left: SerialComplianceDecision[],
  right: SerialComplianceDecision[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (decision, index) =>
        decision.serialNumber === right[index]?.serialNumber &&
        decision.noncompliant === right[index]?.noncompliant,
    )
  );
}

async function readJson<T>(response: Response, maximum: number): Promise<T> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximum) throw new Error("Cloudflare response is too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Cloudflare returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("Cloudflare response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Error(`Cloudflare returned invalid JSON (${response.status})`);
  }
}

function positiveNumber(value: string, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value: string, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
