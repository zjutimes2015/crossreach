// ── Session tokens (JWT, HS256) ─────────────────────────────────────────────
// Stateless signed session for the dashboard. The tenant API key remains the
// credential for programmatic /v1/* calls; the JWT only identifies *who* is
// signed in (user + tenant) for /api/auth/*.

import { SignJWT, jwtVerify } from 'jose';
import { config } from '../../config/index.js';
import { AuthError } from './errors.js';

/** Development-only default. Production must set AUTH_JWT_SECRET explicitly. */
const DEV_FALLBACK_SECRET = 'crossreach-dev-only-secret-change-me';

export interface SessionClaims {
  userId: string;
  tenantId: string;
}

function secretKey(): Uint8Array {
  const secret = config.AUTH_JWT_SECRET || DEV_FALLBACK_SECRET;
  if (config.isProd && secret === DEV_FALLBACK_SECRET) {
    throw new AuthError(
      500,
      'auth_not_configured',
      'AUTH_JWT_SECRET must be set to a strong random value in production',
    );
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(userId: string, tenantId: string): Promise<string> {
  return new SignJWT({ tenantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.AUTH_SESSION_TTL_DAYS}d`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const userId = payload.sub;
    const tenantId = payload.tenantId as string | undefined;
    if (!userId || !tenantId) throw new Error('missing claims');
    return { userId, tenantId };
  } catch {
    throw new AuthError(401, 'invalid_session', 'Session token is invalid or expired');
  }
}
