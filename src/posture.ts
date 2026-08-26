import type {
  CloudflareDevice,
  CortexEndpoint,
  Evaluation,
} from "./types";

export function evaluateEndpoint(
  endpoint: CortexEndpoint | null,
  now: number,
  maxContentAgeDays: number,
  maxLastSeenMinutes: number,
): Evaluation {
  if (!endpoint) {
    return { score: 0, reason: "endpoint_not_found_or_ambiguous" };
  }

  const status = String(endpoint.operational_status ?? "").toLowerCase();
  if (status !== "protected") {
    return {
      score: 0,
      reason: `operational_status_${status || "missing"}`,
    };
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

  if (maxLastSeenMinutes > 0) {
    const lastSeen = normalizeTimestamp(endpoint.last_seen);
    if (!lastSeen) {
      return { score: 0, reason: "last_seen_missing" };
    }
    if (lastSeen > now + 5 * 60_000) {
      return { score: 0, reason: "last_seen_in_future" };
    }
    if (now - lastSeen > maxLastSeenMinutes * 60_000) {
      return { score: 0, reason: "endpoint_not_seen_recently" };
    }
  }

  return { score: 100, reason: "protected_and_content_fresh" };
}

export function findCortexEndpoint(
  device: CloudflareDevice,
  endpoints: CortexEndpoint[],
): CortexEndpoint | null {
  const hostname = normalizeHostname(device.hostname);
  const deviceMacs = normalizeMacCollection(device.mac_address);
  if (!hostname || deviceMacs.size === 0) return null;

  const matches = endpoints.filter((endpoint) => {
    const endpointHostname = normalizeHostname(
      endpoint.endpoint_name ?? endpoint.host_name,
    );
    if (endpointHostname !== hostname) return false;

    const endpointMacs = normalizeMacCollection(endpoint.mac_address);
    return [...deviceMacs].some((mac) => endpointMacs.has(mac));
  });

  if (matches.length !== 1) return null;
  return matches[0] ?? null;
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

export function normalizeTimestamp(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}
