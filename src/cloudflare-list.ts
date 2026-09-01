import {
  clearSerialRemovals,
  getSerialComplianceDecisions,
  type SerialComplianceDecision,
} from "./repository";

const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const EMPTY_LIST_SENTINEL = "__cortex_no_noncompliant_devices__";
const FALLBACK_LIST_NAME = "Cortex noncompliant devices";

interface ListItem {
  value?: string;
  description?: string;
}

interface ZeroTrustList {
  id?: string;
  name?: string;
  type?: string;
  count?: number;
  description?: string;
  items?: ListItem[];
}

interface ApiEnvelope<T> {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
}

export interface SerialListEnv {
  DB: D1Database;
  CLOUDFLARE_API_TOKEN?: string;
  RECOVERY_REFRESH_MINUTES?: string;
}

export interface SerialListSyncConfig {
  cloudflareAccountId: string;
  serialListId: string;
  maxContentAgeDays: number;
  listMaxItems: number;
}

interface CloudflareListContext {
  apiToken: string;
  accountId: string;
  listId: string;
}

export interface AvailableSerialList {
  id: string;
  name: string;
  count: number;
  description: string | null;
}

export interface AccountSerialLists {
  accountId: string;
  accountName: string;
  lists: AvailableSerialList[];
}

export interface SerialListSyncResult {
  changed: boolean;
  count: number;
}

export async function reconcileNoncompliantSerialList(
  env: SerialListEnv,
  config: SerialListSyncConfig,
  now = Date.now(),
): Promise<SerialListSyncResult> {
  requireConfiguration(env, config);
  const maximumAge = config.maxContentAgeDays * 86_400_000;
  // Decision freshness keys off the recovery tier: denylist members are
  // refreshed at that cadence, so their add/remove decisions are always
  // produced, while fleet-wide sweeps are only needed for detection.
  const recoveryMinutes = positiveNumber(env.RECOVERY_REFRESH_MINUTES, 30);
  const refreshedAfter = now - recoveryMinutes * 2 * 60_000;
  let decisions = await getSerialComplianceDecisions(
    env.DB,
    maximumAge,
    refreshedAfter,
  );
  let result: SerialListSyncResult = { changed: false, count: 0 };
  let stable = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentResult = await syncSerialList(decisions, env, config);
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
  env: Pick<SerialListEnv, "CLOUDFLARE_API_TOKEN">,
  config: SerialListSyncConfig,
): Promise<SerialListSyncResult> {
  const ctx = requireConfiguration(env, config);
  const current = await getList(ctx);
  const currentItems = listItems(current);
  const desired = new Map(
    currentItems
      .filter((item) => item.value !== EMPTY_LIST_SENTINEL)
      .map((item) => [item.value, item.description] as const),
  );
  for (const decision of decisions) {
    const serial = decision.serialNumber.trim();
    if (!serial) continue;
    if (decision.noncompliant) {
      desired.set(serial, decision.description ?? desired.get(serial) ?? "");
    }
    else desired.delete(serial);
  }
  const serials = [...desired.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  const maximumItems = config.listMaxItems;
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

  const desiredItems: ListItem[] =
    serials.length > 0
      ? serials.map((value) => ({
          value,
          ...(desired.get(value) ? { description: desired.get(value) } : {}),
        }))
      : [
          {
            value: EMPTY_LIST_SENTINEL,
            description: "No noncompliant Cortex devices",
          },
        ];
  if (sameValues(listItems(current), desiredItems)) {
    return { changed: false, count: serials.length };
  }

  await callCloudflare(ctx, "PUT", {
    name: current.name || FALLBACK_LIST_NAME,
    description: "Cortex endpoints with stale security content; managed by Worker",
    items: desiredItems,
  });
  const verified = await getList(ctx);
  if (!sameValues(listItems(verified), desiredItems)) {
    throw new Error("Cloudflare serial list verification failed");
  }
  return { changed: true, count: serials.length };
}

export async function listAvailableSerialLists(
  apiToken: string,
): Promise<AccountSerialLists[]> {
  const token = apiToken.trim();
  if (!token) throw new Error("Cloudflare API token is not configured");
  const accounts = await cfApiGet<
    Array<{ id?: string; name?: string } | null>
  >("/accounts", token);
  const visibleAccounts = (Array.isArray(accounts) ? accounts : [])
    .filter((account): account is { id: string; name?: string } =>
      Boolean(account?.id),
    )
    .slice(0, 10);

  const result: AccountSerialLists[] = [];
  for (const account of visibleAccounts) {
    const lists = await cfApiGet<ZeroTrustList[] | null>(
      `/accounts/${encodeURIComponent(account.id)}/gateway/lists`,
      token,
    );
    result.push({
      accountId: account.id,
      accountName: account.name ?? account.id,
      lists: (Array.isArray(lists) ? lists : [])
        .filter((list) => list.type === "SERIAL" && list.id && list.name)
        .map((list) => ({
          id: list.id as string,
          name: list.name as string,
          count: Number(list.count ?? 0),
          description: list.description ?? null,
        })),
    });
  }
  return result;
}

async function getList(ctx: CloudflareListContext): Promise<ZeroTrustList> {
  const list = await callCloudflare(ctx, "GET");
  validateList(list, ctx);
  if (!Array.isArray(list.items)) {
    list.items = await callCloudflareItems(ctx);
  }
  return list;
}

async function callCloudflareItems(
  ctx: CloudflareListContext,
): Promise<ListItem[]> {
  const url = `${API_BASE_URL}/accounts/${encodeURIComponent(ctx.accountId)}/gateway/lists/${encodeURIComponent(ctx.listId)}/items`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${ctx.apiToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await response.body?.cancel();
      await sleep(attempt * 500);
      continue;
    }
    const parsed = await readJson<ApiEnvelope<ListItem[]>>(
      response,
      MAX_RESPONSE_BYTES,
    );
    if (
      !response.ok ||
      parsed.success !== true ||
      !Array.isArray(parsed.result)
    ) {
      const detail = parsed.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new Error(`Cloudflare Zero Trust list items request failed: ${detail}`);
    }
    return parsed.result;
  }
  throw new Error("Cloudflare Zero Trust list items retry limit reached");
}

async function callCloudflare(
  ctx: CloudflareListContext,
  method: "GET" | "PUT",
  body?: unknown,
): Promise<ZeroTrustList> {
  const url = `${API_BASE_URL}/accounts/${encodeURIComponent(ctx.accountId)}/gateway/lists/${encodeURIComponent(ctx.listId)}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(
      url,
      method === "GET"
        ? {
            method: "GET",
            headers: { authorization: `Bearer ${ctx.apiToken}` },
            signal: AbortSignal.timeout(15_000),
          }
        : {
            method: "PUT",
            headers: {
              authorization: `Bearer ${ctx.apiToken}`,
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

    const parsed = await readJson<ApiEnvelope<ZeroTrustList>>(
      response,
      MAX_RESPONSE_BYTES,
    );
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

async function cfApiGet<T>(path: string, apiToken: string): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await response.body?.cancel();
      await sleep(attempt * 500);
      continue;
    }
    const parsed = await readJson<ApiEnvelope<T>>(response, MAX_RESPONSE_BYTES);
    if (!response.ok || parsed.success !== true) {
      const detail = parsed.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new Error(`Cloudflare API request failed: ${detail}`);
    }
    return parsed.result as T;
  }
  throw new Error("Cloudflare API retry limit reached");
}

function validateList(list: ZeroTrustList, ctx: CloudflareListContext): void {
  if (list.id !== ctx.listId) {
    throw new Error("Cloudflare returned an unexpected Zero Trust list");
  }
  if (list.type !== "SERIAL") {
    throw new Error("Configured Zero Trust list must have type SERIAL");
  }
}

function requireConfiguration(
  env: Pick<SerialListEnv, "CLOUDFLARE_API_TOKEN">,
  config: SerialListSyncConfig,
): CloudflareListContext {
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (
    !apiToken ||
    !config.cloudflareAccountId ||
    !config.serialListId ||
    config.serialListId.startsWith("replace-")
  ) {
    throw new Error("Cloudflare serial list synchronization is not configured");
  }
  return {
    apiToken,
    accountId: config.cloudflareAccountId,
    listId: config.serialListId,
  };
}

function listItems(list: ZeroTrustList): Required<ListItem>[] {
  if (!Array.isArray(list.items)) {
    throw new Error("Cloudflare Zero Trust list response did not include items");
  }
  const items = new Map<string, string>();
  for (const item of list.items) {
    const value = item.value?.trim();
    if (value) items.set(value, item.description?.trim() ?? "");
  }
  return [...items.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, description]) => ({ value, description }));
}

function sameValues(left: ListItem[], right: ListItem[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.value?.trim() === right[index]?.value?.trim() &&
        (item.description?.trim() ?? "") ===
          (right[index]?.description?.trim() ?? ""),
    )
  );
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
        decision.noncompliant === right[index]?.noncompliant &&
        decision.description === right[index]?.description,
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

function positiveNumber(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
