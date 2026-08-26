import { getStoredEvaluationByVirtualIp } from "./repository";
import type { GatewayContext } from "./types";

export async function evaluateGatewayContext(
  body: unknown,
  env: {
    DB: D1Database;
    GATEWAY_ACCOUNT_TAG: string;
    GATEWAY_IP_MAX_AGE_MINUTES: string;
  },
): Promise<Response> {
  const context = parseGatewayContext(body);
  if (!context || context.account_tag !== env.GATEWAY_ACCOUNT_TAG) {
    return result(0);
  }

  try {
    const configuredAge = Number(env.GATEWAY_IP_MAX_AGE_MINUTES);
    const maximumAgeMinutes =
      Number.isFinite(configuredAge) && configuredAge > 0 ? configuredAge : 30;
    const evaluation = await getStoredEvaluationByVirtualIp(
      env.DB,
      context.src_ip,
      Date.now() - maximumAgeMinutes * 60_000,
    );
    return result(evaluation?.score ?? 0);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "gateway_posture_lookup_error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return result(0);
  }
}

export function parseGatewayContext(body: unknown): GatewayContext | null {
  if (!isRecord(body)) return null;
  const value = isRecord(body.context) ? body.context : body;
  if (
    !boundedString(value.src_ip, 64) ||
    !port(value.src_port) ||
    !boundedString(value.dst_ip, 64) ||
    !port(value.dst_port) ||
    !boundedString(value.protocol, 32) ||
    typeof value.sni !== "string" ||
    value.sni.length > 255 ||
    !boundedString(value.account_tag, 64)
  ) {
    return null;
  }

  return value as unknown as GatewayContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function port(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 65_535;
}

function result(score: number): Response {
  return Response.json(
    { result: score },
    { headers: { "cache-control": "no-store" } },
  );
}
