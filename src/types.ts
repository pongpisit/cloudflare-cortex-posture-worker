export interface CloudflareDevice {
  device_id: string;
  email?: string;
  serial_number?: string;
  mac_address?: string | string[];
  virtual_ipv4?: string;
  hostname?: string;
}

export interface CortexEndpoint {
  endpoint_id: string;
  endpoint_name?: string;
  host_name?: string;
  endpoint_status?: string;
  operational_status?: string;
  last_content_update_time?: number | string;
  last_seen?: number | string;
  mac_address?: string | string[];
}

export interface StoredEvaluation {
  cloudflareDeviceId: string;
  cortexEndpointId: string;
  score: number | null;
  reason: string | null;
  cortexRefreshedAt: number | null;
  hostname: string;
  verifiedMac: string;
  serialNumber: string | null;
}

export type RefreshMessage =
  | { type: "refresh"; endpointIds: string[]; leaseToken?: string }
  | {
      type: "discover";
      devices: CloudflareDevice[];
      observationId?: string;
      observedAt?: number;
    };

export interface Evaluation {
  score: number;
  reason: string;
}

export type RuntimeEnv = Env & {
  CORTEX_API_KEY: string;
  CORTEX_API_KEY_ID: string;
};
