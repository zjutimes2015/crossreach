// ── Discovery Routes (对标 Revor MCP) ───────────────────────────────────────
// POST   /api/v1/discovery/websets            — create a prospect list from an ICP
// GET    /api/v1/discovery/websets             — list prospect lists (cursor pagination)
// GET    /api/v1/discovery/websets/:id         — get webset status + progress + criteria
// GET    /api/v1/discovery/websets/:id/items   — page through ranked results (detail modes)
// POST   /api/v1/discovery/research            — research companies/markets from public web
// POST   /api/v1/discovery/contacts            — find decision-makers by verified domain
// GET    /api/v1/discovery/jobs/:id            — poll a discovery job's status + result
// POST   /api/v1/discovery/jobs/:id/cancel     — cancel a queued job

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createWebset,
  listWebsets,
  getWebset,
  listWebsetItems,
  WebsetError,
  type DetailMode,
} from '../../modules/discovery/webset.js';
import { runResearch, findContacts, DiscoveryError } from '../../modules/discovery/research-contacts.js';
import { getDiscoveryJob, cancelDiscoveryJob } from '../../modules/discovery/jobs.js';

export async function discoveryRoutes(server: FastifyInstance) {
  // ── POST /v1/discovery/websets — create a prospect list ────────────────────
  server.post('/v1/discovery/websets', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as {
      name?: string;
      targetKind: 'COMPANY' | 'PERSON';
      criteria: {
        prompt: string;
        region?: string;
        industry?: string;
        role?: string;
        seniority?: string;
        count?: number;
      };
      idempotencyKey?: string;
    };

    const idempotencyKey = body.idempotencyKey ?? (req.headers['idempotency-key'] as string | undefined);

    try {
      const result = await createWebset(tenant.id, tenant.plan, { ...body, idempotencyKey });
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof WebsetError) {
        return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // ── GET /v1/discovery/websets — list prospect lists ───────────────────────
  server.get('/v1/discovery/websets', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const q = req.query as { limit?: string; cursor?: string };
    const result = await listWebsets(tenant.id, {
      limit: q.limit ? Number(q.limit) : 20,
      cursor: q.cursor,
    });
    return reply.send(result);
  });

  // ── GET /v1/discovery/websets/:id — webset status + criteria ──────────────
  server.get('/v1/discovery/websets/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const ws = await getWebset(tenant.id, id);
    if (!ws) {
      return reply.status(404).send({ ok: false, error: { code: 'webset_not_found', message: 'The prospect list was not found' } });
    }
    return reply.send({ ok: true, item: ws });
  });

  // ── GET /v1/discovery/websets/:id/items — paginated ranked results ────────
  server.get('/v1/discovery/websets/:id/items', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const q = req.query as { detail?: DetailMode; limit?: string; cursor?: string };
    const result = await listWebsetItems(tenant.id, id, {
      detail: q.detail,
      limit: q.limit ? Number(q.limit) : undefined,
      cursor: q.cursor,
    });
    if (!result) {
      return reply.status(404).send({ ok: false, error: { code: 'webset_not_found', message: 'The prospect list was not found' } });
    }
    return reply.send({ ok: true, ...result });
  });

  // ── POST /v1/discovery/research — public web research ──────────────────────
  server.post('/v1/discovery/research', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    try {
      const result = await runResearch(tenant.id, req.body as Parameters<typeof runResearch>[1]);
      return reply.send(result);
    } catch (err) {
      if (err instanceof DiscoveryError) {
        return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // ── POST /v1/discovery/contacts — find decision-makers by domain ──────────
  server.post('/v1/discovery/contacts', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    try {
      const result = await findContacts(tenant.id, req.body as Parameters<typeof findContacts>[1]);
      return reply.send(result);
    } catch (err) {
      if (err instanceof DiscoveryError) {
        return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // ── GET /v1/discovery/jobs/:id — poll a discovery job ──────────────────────
  server.get('/v1/discovery/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const result = await getDiscoveryJob(tenant.id, id);
    if (!result) {
      return reply.status(404).send({ ok: false, error: { code: 'job_not_found', message: 'The job was not found' } });
    }
    return reply.send(result);
  });

  // ── POST /v1/discovery/jobs/:id/cancel — cancel a queued job ──────────────
  server.post('/v1/discovery/jobs/:id/cancel', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const result = await cancelDiscoveryJob(tenant.id, id);
    if ('error' in result) {
      return reply.status(409).send(result);
    }
    return reply.send(result);
  });
}
