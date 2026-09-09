// ── Auth service ─────────────────────────────────────────────────────────────
// Self-serve onboarding: signup auto-provisions a TRIAL tenant + ADMIN user,
// and issues both a dashboard session (JWT) and the tenant API key for
// programmatic /v1/* calls. Login verifies the bcrypt hash and returns the
// same pair so the dashboard can call authenticated endpoints with x-api-key.

import { Prisma, type User, type Tenant } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { AuthError } from './errors.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { createSessionToken } from './tokens.js';

export interface AuthResult {
  token: string;
  apiKey: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    authProvider: string;
  };
  tenant: {
    id: string;
    name: string;
    plan: string;
    status: string;
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Sign up (create tenant + admin) ─────────────────────────────────────────

export async function signupTenant(input: {
  name: string;
  companyName: string;
  email: string;
  password: string;
}): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const hashed = await hashPassword(input.password);

  try {
    // Tenant + admin user are created atomically: if the email is already
    // registered the whole transaction rolls back (no orphaned tenant).
    const { tenant, user } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: input.companyName.trim(),
          // New signups get the Starter quota as a free trial until a paid
          // subscription activates (Stripe webhook flips status to ACTIVE).
          plan: 'STARTER',
          status: 'TRIAL',
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          name: input.name.trim(),
          role: 'ADMIN',
          authProvider: 'PASSWORD',
          password: hashed,
        },
      });
      return { tenant, user };
    });

    const token = await createSessionToken(user.id, tenant.id);
    return { token, apiKey: tenant.apiKey, user: viewUser(user), tenant: viewTenant(tenant) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AuthError(409, 'email_taken', 'An account with this email already exists');
    }
    throw err;
  }
}

// ── Log in (email + password) ───────────────────────────────────────────────

export async function loginUser(input: { email: string; password: string }): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({
    where: { email },
    include: { tenant: true },
  });

  const passwordOk =
    user &&
    user.authProvider === 'PASSWORD' &&
    user.password != null &&
    (await verifyPassword(input.password, user.password));

  if (!user || !passwordOk) {
    throw new AuthError(401, 'invalid_credentials', 'Incorrect email or password');
  }
  if (user.tenant.status === 'SUSPENDED') {
    throw new AuthError(403, 'tenant_suspended', 'This account has been suspended');
  }

  const token = await createSessionToken(user.id, user.tenantId);
  return {
    token,
    apiKey: user.tenant.apiKey,
    user: viewUser(user),
    tenant: viewTenant(user.tenant),
  };
}

// ── Resolve a session (GET /me) ─────────────────────────────────────────────

export async function sessionOf(userId: string): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { tenant: true },
  });
  if (!user) throw new AuthError(401, 'invalid_session', 'Session user no longer exists');
  if (user.tenant.status === 'SUSPENDED') {
    throw new AuthError(403, 'tenant_suspended', 'This account has been suspended');
  }

  const token = await createSessionToken(user.id, user.tenantId);
  return {
    token,
    apiKey: user.tenant.apiKey,
    user: viewUser(user),
    tenant: viewTenant(user.tenant),
  };
}

// ── View helpers (never leak password hash) ─────────────────────────────────

function viewUser(user: User): AuthResult['user'] {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    authProvider: user.authProvider,
  };
}

function viewTenant(tenant: Tenant): AuthResult['tenant'] {
  return {
    id: tenant.id,
    name: tenant.name,
    plan: tenant.plan,
    status: tenant.status,
  };
}
