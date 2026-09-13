import type {
  BindMethod,
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

// Bindings are established with a fixed evidence ladder:
//   1. MAC intersection across hostname candidates - the strongest join the
//      two systems offer, and the only one that separates clone VMs sharing
//      a hostname.
//   2. A unique hostname match - either a single candidate, or several where
//      all but one are provably dead Cortex records (last seen > 30 days).
//   3. Anything still ambiguous is refused rather than guessed.
// With requireMac, step 2 is disabled: only MAC-corroborated binds happen.
// The liveness window matters because Cortex keeps records for decommissioned
// machines, and a fresh enrollment must not bind to a dead twin's record.
const LIVENESS_WINDOW_MS = 30 * 86_400_000;

export interface ResolveOutcome {
  status: "bound" | "no_match" | "ambiguous" | "mac_required";
  endpoint: CortexEndpoint | null;
  method: BindMethod | null;
}

export function resolveCortexEndpoint(
  device: CloudflareDevice,
  endpoints: CortexEndpoint[],
  now: number,
  options: { requireMac?: boolean } = {},
): ResolveOutcome {
  const hostname = normalizeHostname(device.hostname);
  if (!hostname) return { status: "no_match", endpoint: null, method: null };

  const candidates = endpoints.filter(
    (endpoint) =>
      normalizeHostname(endpoint.endpoint_name ?? endpoint.host_name) ===
      hostname,
  );
  if (candidates.length === 0) {
    return { status: "no_match", endpoint: null, method: null };
  }

  const outcome = (
    status: ResolveOutcome["status"],
    endpoint: CortexEndpoint | null,
    method: BindMethod | null,
  ): ResolveOutcome => ({ status, endpoint, method });

  // Step 1: MAC evidence. A disjoint set never rules a candidate out — the
  // two systems may each name a different adapter of the same machine.
  const deviceMacs = normalizeMacCollection(device.mac_address);
  if (deviceMacs.size > 0) {
    const byMac = candidates.filter((endpoint) => {
      const endpointMacs = normalizeMacCollection(endpoint.mac_address);
      return [...deviceMacs].some((mac) => endpointMacs.has(mac));
    });
    if (byMac.length === 1) {
      return outcome("bound", byMac[0] ?? null, "mac");
    }
    if (byMac.length > 1) {
      return outcome("ambiguous", null, null);
    }
  }

  if (options.requireMac) {
    return outcome("mac_required", null, null);
  }

  // Step 2: unique or liveness-pruned hostname match.
  if (candidates.length === 1) {
    return outcome("bound", candidates[0] ?? null, "hostname");
  }
  const live = candidates.filter((endpoint) => {
    const lastSeen = normalizeTimestamp(endpoint.last_seen);
    return !!lastSeen && now - lastSeen < LIVENESS_WINDOW_MS;
  });
  if (live.length === 1) {
    return outcome("bound", live[0] ?? null, "hostname");
  }
  return outcome("ambiguous", null, null);
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
