// ── Stripe billing routes (authenticated) ────────────────────────────────────
// POST /v1/billing/stripe/checkout  — start Checkout (top-up or subscription)
// GET  /v1/billing/stripe/status    — credits + subscription + recent payments
//
// The inbound /webhooks/stripe receiver lives in routes/webhooks.ts (no auth,
// signature-verified) and calls modules/billing/stripe.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createCheckoutSession } from '../../modules/billing/stripe.js';
import { getBalance } from '../../modules/billing/balance.js';
import { PLANS } from '../../modules/billing/plans.js';
import { prisma } from '../../db/prisma.js';

export async function stripeRoutes(server: FastifyInstance) {
  // POST /v1/billing/stripe/checkout
  server.post('/v1/billing/stripe/checkout', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as {
      creditAmount?: number;
      description?: string;
      successUrl: string;
      cancelUrl: string;
      planId?: string;
    };

    if (!body.successUrl || !body.cancelUrl) {
      return reply.status(400).send({ ok: false, error: { code: 'missing_urls', message: 'successUrl and cancelUrl are required' } });
    }

    try {
      const { url, sessionId } = await createCheckoutSession(tenant.id, {
        creditAmount: body.creditAmount,
        description: body.description,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        planId: body.planId as Parameters<typeof createCheckoutSession>[1]['planId'],
      });
      return reply.send({ ok: true, sessionId, url });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'stripe_error';
      return reply.status(400).send({ ok: false, error: { code, message: String(err) } });
    }
  });

  // GET /v1/billing/stripe/status
  server.get('/v1/billing/stripe/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const balance = await getBalance(tenant.id, tenant.plan);
    const stripeCustomer = await prisma.stripeCustomer.findUnique({ where: { tenantId: tenant.id } });
    const payments = await prisma.paymentEvent.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, amount: true, currency: true, success: true, eventKind: true, createdAt: true },
    });
    return reply.send({
      ok: true,
      balance,
      stripe: {
        customerId: stripeCustomer?.stripeCustomerId ?? null,
        status: stripeCustomer?.status ?? null,
        lastSessionId: stripeCustomer?.lastSessionId ?? null,
        lastPlanId: stripeCustomer?.lastPlanId ?? null,
      },
      recentPayments: payments,
      plans: Object.entries(PLANS)
        .map(([key, p]) => ({
          id: key,
          label: p.label,
          monthlyPriceCents: p.monthlyPriceCents,
          monthlyCredits: p.monthlyCredits,
          socialChannels: p.socialChannels,
          emailInboxes: p.emailInboxes,
        }))
        .filter((p) => p.monthlyPriceCents !== null),
    });
  });
}
