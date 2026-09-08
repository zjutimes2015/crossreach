// ── Connect Routes (对标 Revor "Connect" page) ───────────────────────────────
// Manage connected sending accounts (email / LinkedIn / WhatsApp) that the
// outreach dispatch pipeline uses to send outbound messages.
//
// POST   /v1/connect/accounts              — link a new sending account
// GET    /v1/connect/accounts             — list connected accounts
// GET    /v1/connect/accounts/:id          — get one account (secrets masked)
// PATCH  /v1/connect/accounts/:id          — update name / config / status
// DELETE /v1/connect/accounts/:id          — disconnect an account
// POST   /v1/connect/accounts/:id/test     — verify the connection works
// POST   /v1/connect/accounts/:id/reconnect — mark session as needing refresh

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createConnectAccount,
  listConnectAccounts,
  getConnectAccount,
  updateConnectAccount,
  deleteConnectAccount,
  testConnectAccount,
  markReconnectRequired,
  ConnectError,
} from '../../modules/connect/service.js';
import type { ConnectChannelType, ConnectAccountStatus } from '@prisma/client';

export async function connectRoutes(server: FastifyInstance) {
  // ── POST /v1/connect/accounts — create ────────────────────────────────────
  server.post('/v1/connect/accounts', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    try {
      const account = await createConnectAccount(
        tenant.id,
        tenant.plan,
        req.body as Parameters<typeof createConnectAccount>[2],
      );
      return reply.status(201).send({ ok: true, account });
    } catch (err) {
      if (err instanceof ConnectError) {
        return reply
          .status(err.statusCode)
          .send({ ok: false, error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // ── GET /v1/connect/accounts — list ──────────────────────────────────────
  server.get('/v1/connect/accounts', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const q = req.query as { channel?: ConnectChannelType; status?: ConnectAccountStatus };
    const result = await listConnectAccounts(tenant.id, tenant.plan, q);
    return reply.send({ ok: true, ...result });
  });

  // ── GET /v1/connect/accounts/:id — get one ───────────────────────────────
  // Pass ?reveal=1 to unmask secrets (used by the tenant's own setup flow).
  server.get('/v1/connect/accounts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const q = req.query as { reveal?: string };
    const reveal = q.reveal === '1' || q.reveal === 'true';
    const account = await getConnectAccount(tenant.id, id, { revealSecrets: reveal });
    if (!account) {
      return reply
        .status(404)
        .send({ ok: false, error: { code: 'account_not_found', message: 'connect account not found' } });
    }
    return reply.send({ ok: true, account });
  });

  // ── PATCH /v1/connect/accounts/:id — update ─────────────────────────────
  server.patch('/v1/connect/accounts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    try {
      const account = await updateConnectAccount(
        tenant.id,
        id,
        req.body as Parameters<typeof updateConnectAccount>[2],
      );
      return reply.send({ ok: true, account });
    } catch (err) {
      if (err instanceof ConnectError) {
        return reply
          .status(err.statusCode)
          .send({ ok: false, error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // ── DELETE /v1/connect/accounts/:id — disconnect ─────────────────────────
  server.delete('/v1/connect/accounts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    try {
      const result = await deleteConnectAccount(tenant.id, id);
      return reply.send(result);
    } catch (err) {
      if (err instanceof ConnectError) {
        return reply
          .status(err.statusCode)
          .send({ ok: false, error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // ── POST /v1/connect/accounts/:id/test — verify connection ───────────────
  server.post('/v1/connect/accounts/:id/test', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    try {
      const result = await testConnectAccount(tenant.id, id);
      return reply.send(result);
    } catch (err) {
      if (err instanceof ConnectError) {
        return reply
          .status(err.statusCode)
          .send({ ok: false, error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // ── POST /v1/connect/accounts/:id/reconnect — mark reconnect_required ────
  server.post(
    '/v1/connect/accounts/:id/reconnect',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const tenant = req.tenant!;
      const { id } = req.params as { id: string };
      try {
        const account = await markReconnectRequired(tenant.id, id);
        return reply.send({ ok: true, account });
      } catch (err) {
        if (err instanceof ConnectError) {
          return reply
            .status(err.statusCode)
            .send({ ok: false, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );
}
