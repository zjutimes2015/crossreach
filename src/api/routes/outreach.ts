// ── Outreach Routes (对标 Revor API) ───────────────────────────────────────
// POST /api/v1/outreach/dispatches         — create an email/linkedin/whatsapp outreach task
// POST /api/v1/outreach/linkedin/post-likes — like a prospect's relevant LinkedIn post
// GET  /api/v1/outreach/jobs/:id           — check job status & result
// Note: Connect Account CRUD lives at /v1/connect/accounts (see connect.ts).

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createDispatch, createLinkedInPostLike, DispatchError } from '../../modules/outreach/dispatch.js';
import { getJobStatus } from '../../modules/outreach/job-status.js';

export async function outreachRoutes(server: FastifyInstance) {
  // ── POST /api/v1/outreach/dispatches ────────────────────────────────────
  server.post('/v1/outreach/dispatches', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as Parameters<typeof createDispatch>[2] & { idempotencyKey?: string };

    // Honor the Idempotency-Key header if no body key was supplied
    const idempotencyKey =
      body.idempotencyKey ?? (req.headers['idempotency-key'] as string | undefined);

    try {
      const result = await createDispatch(tenant.id, tenant.plan, { ...body, idempotencyKey });
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof DispatchError) {
        return reply.status(err.statusCode).send({
          ok: false,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  // ── POST /api/v1/outreach/linkedin/post-likes ───────────────────────────
  server.post('/v1/outreach/linkedin/post-likes', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as {
      connectAccountId: string;
      profileUrl: string;
      topic?: string;
      metadata?: Record<string, unknown>;
    };

    try {
      const result = await createLinkedInPostLike(tenant.id, tenant.plan, body);
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof DispatchError) {
        return reply.status(err.statusCode).send({
          ok: false,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  // ── GET /api/v1/outreach/jobs/:id ──────────────────────────────────────
  server.get('/v1/outreach/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };

    const result = await getJobStatus(tenant.id, id);
    if (!result) {
      return reply.status(404).send({ ok: false, error: { code: 'task_not_found', message: 'The task was not found' } });
    }
    return reply.send(result);
  });
}
