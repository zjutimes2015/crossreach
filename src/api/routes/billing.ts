// ── Billing Routes (对标 Revor credits / billing API) ────────────────────────
// GET  /api/v1/billing/balance        — current credit balance + cycle info
// GET  /api/v1/billing/plan           — current plan + tier limits
// POST /api/v1/billing/top-up         — purchase credit pack
// GET  /api/v1/billing/usage          — aggregated usage summary (+ optional ?from&to)
// GET  /api/v1/billing/usage/events   — raw usage events (cursor pagination)
// GET  /api/v1/billing/transactions   — credit ledger (cursor pagination)

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getBalance,
  topUpCredits,
  listTransactions,
  BillingError,
} from '../../modules/billing/balance.js';
import { getUsageSummary, listUsageEvents } from '../../modules/billing/metering.js';
import { PLANS } from '../../modules/billing/plans.js';
import type { CreditTransactionType, UsageResourceType } from '@prisma/client';

export async function billingRoutes(server: FastifyInstance) {
  // ── GET /v1/billing/balance ─────────────────────────────────────────────
  server.get('/v1/billing/balance', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const balance = await getBalance(tenant.id, tenant.plan);
    return reply.send({ ok: true, balance });
  });

  // ── GET /v1/billing/plan ────────────────────────────────────────────────
  server.get('/v1/billing/plan', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const plan = PLANS[tenant.plan];
    return reply.send({
      ok: true,
      plan: {
        name: tenant.plan,
        label: plan.label,
        isTrial: tenant.status === 'TRIAL',
        monthlyCredits: plan.monthlyCredits,
        allowedListSizes: plan.allowedListSizes,
        emailInboxes: plan.emailInboxes,
        socialChannels: plan.socialChannels,
        effectiveCostPerLead: plan.effectiveCostPerLead,
      },
    });
  });

  // ── POST /v1/billing/top-up ─────────────────────────────────────────────
  server.post('/v1/billing/top-up', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as { amount?: number; description?: string };

    try {
      const result = await topUpCredits(tenant.id, body.amount ?? 0, {
        description: body.description,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof BillingError) {
        return reply.status(err.statusCode).send({
          ok: false,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  // ── GET /v1/billing/usage — aggregated summary ──────────────────────────
  server.get('/v1/billing/usage', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const q = req.query as { from?: string; to?: string };
    const summary = await getUsageSummary(tenant.id, {
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    return reply.send({ ok: true, usage: summary });
  });

  // ── GET /v1/billing/usage/events — raw events (paginated) ──────────────
  server.get('/v1/billing/usage/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const q = req.query as {
      limit?: string;
      cursor?: string;
      resource?: UsageResourceType;
    };
    const result = await listUsageEvents(tenant.id, {
      limit: q.limit ? Number(q.limit) : 50,
      cursor: q.cursor,
      resource: q.resource,
    });
    return reply.send({ ok: true, ...result });
  });

  // ── GET /v1/billing/transactions — credit ledger ───────────────────────
  server.get('/v1/billing/transactions', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const q = req.query as {
      limit?: string;
      cursor?: string;
      type?: CreditTransactionType;
    };
    const result = await listTransactions(tenant.id, {
      limit: q.limit ? Number(q.limit) : 50,
      cursor: q.cursor,
      type: q.type,
    });
    return reply.send({ ok: true, ...result });
  });
}
