// ── Auth routes (unauthenticated) ────────────────────────────────────────────
// POST /api/auth/signup  — self-serve: create tenant + admin, return session
// POST /api/auth/login   — email + password → session
// GET  /api/auth/me      — refresh session / who am I (Bearer token)
//
// Registered OUTSIDE the /api scope that runs tenantMiddleware, so signup and
// login never require an x-api-key. The returned `apiKey` is the credential for
// all other /v1/* endpoints; the `token` is the dashboard session (JWT).

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import {
  signupTenant,
  loginUser,
  sessionOf,
  type AuthResult,
} from '../../modules/auth/service.js';
import { verifySessionToken } from '../../modules/auth/tokens.js';
import { AuthError } from '../../modules/auth/errors.js';

const signupSchema = z.object({
  name: z.string().trim().min(1, 'Your name is required').max(120),
  companyName: z.string().trim().min(1, 'Company name is required').max(120),
  email: z.string().trim().email('Enter a valid email').max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email').max(254),
  password: z.string().min(1).max(128),
});

export async function authRoutes(server: FastifyInstance) {
  const ok = (result: AuthResult) => ({ ok: true as const, ...result });

  const guardError = (err: unknown, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply
        .status(400)
        .send({ ok: false, error: { code: 'validation_error', message: first?.message ?? 'Invalid input' } });
    }
    if (err instanceof AuthError) {
      return reply
        .status(err.statusCode)
        .send({ ok: false, error: { code: err.code, message: err.message } });
    }
    server.log.error({ err }, 'Auth route error');
    return reply
      .status(500)
      .send({ ok: false, error: { code: 'internal_error', message: 'Something went wrong' } });
  };

  // POST /api/auth/signup
  server.post('/signup', async (req, reply) => {
    try {
      const body = signupSchema.parse(req.body);
      const result = await signupTenant(body);
      return reply.status(201).send(ok(result));
    } catch (err) {
      return guardError(err, reply);
    }
  });

  // POST /api/auth/login
  server.post('/login', async (req, reply) => {
    try {
      const body = loginSchema.parse(req.body);
      const result = await loginUser(body);
      return reply.send(ok(result));
    } catch (err) {
      return guardError(err, reply);
    }
  });

  // GET /api/auth/me  (requires Authorization: Bearer <token>)
  server.get('/me', async (req, reply) => {
    try {
      const token = bearerToken(req.headers.authorization);
      const claims = await verifySessionToken(token);
      const result = await sessionOf(claims.userId);
      return reply.send(ok(result));
    } catch (err) {
      return guardError(err, reply);
    }
  });
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    throw new AuthError(401, 'missing_token', 'Authorization: Bearer <token> header is required');
  }
  return authorization.slice('Bearer '.length).trim();
}
