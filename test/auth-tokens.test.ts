import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { createSessionToken, verifySessionToken } from '../src/modules/auth/tokens.js';
import { config } from '../src/config/index.js';
import { AuthError } from '../src/modules/auth/errors.js';

const secret = () => new TextEncoder().encode(config.AUTH_JWT_SECRET || 'crossreach-dev-only-secret-change-me');

async function signExpired(sub: string, tenantId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tenantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt(now - 7200)
    .setExpirationTime(now - 3600) // expired one hour ago
    .sign(secret());
}

async function expectAuthError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error('expected verifySessionToken to reject');
  } catch (err) {
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe(code);
    expect((err as AuthError).statusCode).toBe(401);
  }
}

describe('session tokens (JWT, HS256)', () => {
  it('round-trips userId + tenantId claims', async () => {
    const token = await createSessionToken('user_123', 'tenant_456');
    const claims = await verifySessionToken(token);
    expect(claims).toEqual({ userId: 'user_123', tenantId: 'tenant_456' });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const tampered = await new SignJWT({ tenantId: 'tenant_456' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user_123')
      .setExpirationTime('30d')
      .sign(new TextEncoder().encode('some-other-secret'));
    await expectAuthError(verifySessionToken(tampered), 'invalid_session');
  });

  it('rejects an expired token', async () => {
    const expired = await signExpired('user_123', 'tenant_456');
    await expectAuthError(verifySessionToken(expired), 'invalid_session');
  });

  it('rejects a missing or malformed token', async () => {
    await expectAuthError(verifySessionToken('not-a-jwt'), 'invalid_session');
    await expectAuthError(verifySessionToken(''), 'invalid_session');
  });
});
