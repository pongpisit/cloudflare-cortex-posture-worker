import type {
  CloudflareDevice,
  CortexEndpoint,
  Evaluation,
} from "./types";

export function evaluateEndpoint(
  endpoint: CortexEndpoint | null,
  now: number,
  maxContentAgeDays: number,
): Evaluation {
  if (!endpoint) {
    return { score: 0, reason: "endpoint_not_found_or_ambiguous" };
  }

  const lastContentUpdate = normalizeTimestamp(
    endpoint.last_content_update_time,
  );
  if (!lastContentUpdate) {
    return { score: 0, reason: "last_content_update_missing" };
  }

  const contentAge = now - lastContentUpdate;
  if (contentAge < 0) {
    return { score: 0, reason: "last_content_update_in_future" };
  }
  if (contentAge > maxContentAgeDays * 86_400_000) {
    return { score: 0, reason: "content_older_than_allowed" };
  }

  return { score: 100, reason: "content_fresh" };
}

export function findCortexEndpoint(
  device: CloudflareDevice,
  endpoints: CortexEndpoint[],
): CortexEndpoint | null {
  const hostname = normalizeHostname(device.hostname);
  if (!hostname) return null;

  const byHostname = endpoints.filter(
    (endpoint) =>
      normalizeHostname(endpoint.endpoint_name ?? endpoint.host_name) ===
      hostname,
  );
  if (byHostname.length === 0) return null;
  if (byHostname.length === 1) return byHostname[0] ?? null;

  // Several endpoints share the hostname: disambiguate with the MAC address.
  const deviceMacs = normalizeMacCollection(device.mac_address);
  if (deviceMacs.size === 0) return null;
  const byMac = byHostname.filter((endpoint) => {
    const endpointMacs = normalizeMacCollection(endpoint.mac_address);
    return [...deviceMacs].some((mac) => endpointMacs.has(mac));
  });
  if (byMac.length !== 1) return null;
  return byMac[0] ?? null;
}

export function normalizeHostname(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

export function normalizeMacCollection(value: unknown): Set<string> {
  const values = Array.isArray(value) ? value : [value];
  const result = new Set<string>();

  for (const item of values) {
    const normalized = String(item ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^0-9a-f]/g, "");
    if (normalized.length === 12) result.add(normalized);
  }

  return result;
}

// Normalized form of a single reported MAC address, or null when the poll
// carries none. Seeds the verified MAC set from the legacy single-value
// column when the JSON set has not been populated yet.
export function normalizeMac(value: unknown): string | null {
  return [...normalizeMacCollection(value)][0] ?? null;
}

// Outcome of comparing a polled device against its stored binding identity.
//
// - "confirmed": hostname and MAC evidence agree with the binding.
// - "mac_drift": hostname agrees, but every reported MAC is unknown. Likely a
//   NIC swap or VM reconfiguration on the same machine.
// - "hostname_drift": MAC evidence agrees but the hostname changed. The
//   machine was probably renamed.
// - "replaced": both signals changed simultaneously, which is the signature of
//   a different machine (for example a clone) inheriting the enrollment.
export type IdentityDrift =
  | "confirmed"
  | "mac_drift"
  | "hostname_drift"
  | "replaced";

export function classifyIdentity(
  device: Pick<CloudflareDevice, "hostname" | "mac_address">,
  stored: { hostname: string; verifiedMacs: Set<string> },
): IdentityDrift {
  const hostnameChanged =
    normalizeHostname(device.hostname) !== stored.hostname;
  const reportedMacs = normalizeMacCollection(device.mac_address);
  // MAC drift requires evidence on both sides: an empty stored set (mapping
  // was never corroborated) or an empty reported set (poll carried no MAC)
  // must never be treated as drift.
  const macChanged =
    stored.verifiedMacs.size > 0 &&
    reportedMacs.size > 0 &&
    isDisjoint(stored.verifiedMacs, reportedMacs);

  if (hostnameChanged && macChanged) return "replaced";
  if (hostnameChanged) return "hostname_drift";
  if (macChanged) return "mac_drift";
  return "confirmed";
}

function isDisjoint(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return false;
  }
  return true;
}

// Whether a confirmed poll should persist newly observed MAC addresses into
// the verified set. Absorbs a docked adapter, a switched primary NIC, or a
// Wi-Fi randomization rotation without treating them as drift. Disjoint sets
// are never absorbed — they are classified as mac_drift instead.
export function needsMacsUnion(
  stored: Set<string>,
  reported: Set<string>,
): boolean {
  if (reported.size === 0) return false;
  if (stored.size === 0) return true;
  let overlap = 0;
  for (const mac of reported) {
    if (stored.has(mac)) overlap += 1;
  }
  if (overlap === 0) return false;
  return reported.size > overlap;
}

// Parse the verified MAC set from the JSON column, falling back to the legacy
// single-value column when the JSON is absent or corrupt.
export function parseVerifiedMacs(
  json: string | null | undefined,
  legacyMac: string | null | undefined,
): Set<string> {
  const result = new Set<string>();
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (Array.isArray(parsed)) {
        for (const mac of normalizeMacCollection(parsed)) result.add(mac);
      }
    } catch {
      // Corrupt JSON falls through to the legacy column.
    }
  }
  if (result.size === 0) {
    const legacy = normalizeMac(legacyMac);
    if (legacy) result.add(legacy);
  }
  return result;
}

export interface CoverageSummary {
  scanned: number;
  covered: number;
  uncovered: number;
  coveragePercent: number | null;
}

// How much of the recently seen Cortex fleet has a Cloudflare device mapped
// in D1. Uncovered endpoints are machines that cannot be enforced until they
// enroll in Cloudflare — the coverage audit surfaces them so an operator can
// act, but they are never imported into the denylist pipeline.
export function coverageSummary(
  endpoints: CortexEndpoint[],
  mappedEndpointIds: Set<string>,
): CoverageSummary {
  let covered = 0;
  for (const endpoint of endpoints) {
    if (mappedEndpointIds.has(endpoint.endpoint_id)) covered += 1;
  }
  const scanned = endpoints.length;
  return {
    scanned,
    covered,
    uncovered: scanned - covered,
    coveragePercent:
      scanned === 0 ? null : Math.round((covered / scanned) * 1000) / 10,
  };
}

export function normalizeTimestamp(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}
