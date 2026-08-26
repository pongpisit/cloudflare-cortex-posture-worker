import { evaluateGatewayContext } from "./gateway";

type GatewayEnv = {
  DB: D1Database;
  GATEWAY_ACCOUNT_TAG: string;
  GATEWAY_IP_MAX_AGE_MINUTES: string;
};

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "POST") return result(0);

    try {
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > 16 * 1024) return result(0);
      const bytes = await request.bytes();
      if (bytes.byteLength > 16 * 1024) return result(0);
      const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      return evaluateGatewayContext(body, env);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "gateway_posture_request_rejected",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return result(0);
    }
  },
} satisfies ExportedHandler<GatewayEnv>;

function result(score: number): Response {
  return Response.json(
    { result: score },
    { headers: { "cache-control": "no-store" } },
  );
}
