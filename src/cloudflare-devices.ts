import type { CloudflareDevice } from "./types";

const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PER_PAGE = 100;
// Safety cap: 200 pages x 100 registrations. Beyond that the resync returns a
// truncated flag instead of paging forever.
const MAX_PAGES = 200;

interface ApiEnvelope<T> {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
  result_info?: {
    count?: number;
    page?: number;
    per_page?: number;
    total_count?: number;
    total_pages?: number;
  };
}

// Field subset of GET /accounts/{id}/devices used for discovery. The endpoint
// is deprecated in favor of devices/registrations, but registrations do not
// expose mac_address or serial_number in a single paginated call and the
// deprecated endpoint still returns the full device schema.
interface ZeroTrustDeviceRow {
  id?: string;
  name?: string | null;
  serial_number?: string | null;
  mac_address?: string | null;
  deleted?: boolean | null;
  revoked_at?: string | null;
  user?: { email?: string | null } | null;
}

export interface ZeroTrustInventory {
  devices: CloudflareDevice[];
  revoked: number;
  truncated: boolean;
}

// Pull the enrolled WARP device inventory from the Zero Trust Devices API.
// This is the recovery source when a mapping was deleted while its device is
// offline: the provider only reports devices when they poll, so an offline
// device can never re-enter through /check.
export async function listZeroTrustDevices(
  apiToken: string,
  accountId: string,
): Promise<ZeroTrustInventory> {
  const devices = new Map<string, CloudflareDevice>();
  let revoked = 0;
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/devices?per_page=${PER_PAGE}&page=${page}`;
    let rows: ZeroTrustDeviceRow[] | null = null;
    let totalPages = page;

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
      const parsed = await readJson<ApiEnvelope<ZeroTrustDeviceRow[]>>(
        response,
        MAX_RESPONSE_BYTES,
      );
      if (
        !response.ok ||
        parsed.success !== true ||
        !Array.isArray(parsed.result)
      ) {
        const detail =
          parsed.errors?.[0]?.message ?? `HTTP ${response.status}`;
        throw new Error(
          `Cloudflare device inventory request failed: ${detail}`,
        );
      }
      rows = parsed.result;
      const info = parsed.result_info;
      totalPages =
        typeof info?.total_pages === "number" && info.total_pages > 0
          ? info.total_pages
          : page;
      break;
    }
    if (!rows) throw new Error("Cloudflare device inventory retry limit reached");

    for (const row of rows) {
      if (!row.id || devices.has(row.id)) continue;
      // Revoked or deleted registrations can never pass a posture check
      // again; re-importing them would only push dead serials onto the
      // denylist.
      if (row.deleted === true || row.revoked_at) {
        revoked += 1;
        continue;
      }
      devices.set(row.id, {
        device_id: row.id,
        ...(row.serial_number ? { serial_number: row.serial_number } : {}),
        ...(row.mac_address ? { mac_address: row.mac_address } : {}),
        ...(row.name ? { hostname: row.name } : {}),
        ...(row.user?.email ? { email: row.user.email } : {}),
      });
    }

    if (page >= totalPages) break;
    if (rows.length === 0) break;
    truncated = page >= MAX_PAGES;
  }

  return { devices: [...devices.values()], revoked, truncated };
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
