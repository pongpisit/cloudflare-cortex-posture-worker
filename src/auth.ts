import { createRemoteJWKSet, jwtVerify } from "jose";

export class AuthenticationError extends Error {}

// "access" (default) enforces Cloudflare Access JWT validation. "none" is an
// explicit opt-out for initial setup before the Access application exists.
export function authMode(env: Env): string {
  return (
    (env as Env & { AUTH_MODE?: string }).AUTH_MODE?.trim().toLowerCase() ||
    "access"
  );
}

export async function validateAccessRequest(
  request: Request,
  env: Env,
): Promise<void> {
  if (authMode(env) === "none") return;

  if (
    !env.ACCESS_TEAM_DOMAIN ||
    env.ACCESS_TEAM_DOMAIN.includes("replace-me") ||
    !env.ACCESS_AUD ||
    env.ACCESS_AUD.startsWith("replace-")
  ) {
    throw new Error("Cloudflare Access authentication is not configured");
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    throw new AuthenticationError("Missing Cloudflare Access JWT");
  }

  const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  const jwks = createRemoteJWKSet(
    new URL(`${issuer}/cdn-cgi/access/certs`),
  );

  try {
    await jwtVerify(token, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
  } catch {
    throw new AuthenticationError("Invalid Cloudflare Access JWT");
  }
}
