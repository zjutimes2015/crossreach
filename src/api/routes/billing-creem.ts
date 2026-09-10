// ── Creem billing routes (authenticated) ───────────────────────────────────
// GET  /v1/billing/creem/packs    — fixed credit packs available via Creem
// POST /v1/billing/creem/checkout — start a Creem Checkout for a pack
//
// Creem is a second PSP alongside Stripe and only sells the FIXED credit packs
// (充值包). Arbitrary-amount top-ups and monthly subscriptions stay on Stripe
// (routes/billing-stripe.ts). The inbound /webhooks/creem receiver lives in
// routes/webhooks.ts (no auth, signature-verified) and calls modules/billing/
// creem.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createCreemCheckout, getCreemPacks } from '../../modules/billing/creem.js';

export async function creemRoutes(server: FastifyInstance) {
  // GET /v1/billing/creem/packs
  server.get('/v1/billing/creem/packs', async (_req: FastifyRequest, reply: FastifyReply) => {
    const packs = getCreemPacks();
    return reply.send({
      ok: true,
      configured: packs.length > 0,
      packs: packs.map((p) => ({ ...p })),
    });
  });

  // POST /v1/billing/creem/checkout
  server.post('/v1/billing/creem/checkout', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as { productId?: string; successUrl?: string };

    if (!body.productId || !body.successUrl) {
      return reply.status(400).send({
        ok: false,
        error: { code: 'missing_fields', message: 'productId and successUrl are required' },
      });
    }

    try {
      const { checkoutId, url } = await createCreemCheckout(tenant.id, {
        productId: body.productId,
        successUrl: body.successUrl,
      });
      return reply.send({ ok: true, checkoutId, url });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'creem_error';
      return reply.status(400).send({ ok: false, error: { code, message: String(err) } });
    }
  });
}
