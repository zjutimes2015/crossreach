// ── Inbound webhooks (no auth — each verifies its own signature) ─────────────
//  WhatsApp   GET/POST /webhooks/whatsapp       (Meta signature)
//  Stripe     POST    /webhooks/stripe          (Stripe signature)
//  CRM        POST    /webhooks/hubspot         (CRM payloads → CDP events)
//             POST    /webhooks/salesforce
//             POST    /webhooks/notion

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config/index.js';
import { handleVerification, handleWebhook } from '../../channels/whatsapp/webhook.js';
import { processWebhookResult } from '../../modules/messages/pipeline.js';
import { logger } from '../../utils/logger.js';
import {
  parseHubSpot,
  parseSalesforce,
  parseNotion,
  resolveTenant,
  persistWebhookEvent,
} from '../../modules/crm/webhooks.js';
import { handleStripeWebhook } from '../../modules/billing/stripe.js';

function rawBodyOf(req: FastifyRequest): string {
  return (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
}

export async function webhookRoutes(server: FastifyInstance) {
  // ── WhatsApp ────────────────────────────────────────────────────────────────
  server.get('/webhooks/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>;
    const challenge = handleVerification(query, config.WHATSAPP_VERIFY_TOKEN);
    if (challenge !== null) return reply.status(200).send(challenge);
    return reply.status(403).send({ error: 'Verification failed' });
  });

  server.post('/webhooks/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const result = handleWebhook(rawBodyOf(req), signature, config.META_APP_SECRET);
    if (!result) return reply.status(401).send({ error: 'Signature verification failed' });

    reply.status(200).send({ status: 'received' });
    processWebhookResult(result).catch((err) => {
      logger.error({ err }, 'Background webhook processing failed');
    });
  });

  // ── Stripe ──────────────────────────────────────────────────────────────────
  server.post('/webhooks/stripe', async (req: FastifyRequest, reply: FastifyReply) => {
    const sig = req.headers['stripe-signature'] as string;
    if (!sig) return reply.status(400).send({ ok: false, error: { code: 'missing_stripe_signature' } });
    try {
      await handleStripeWebhook(Buffer.from(rawBodyOf(req), 'utf8'), sig);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      logger.warn({ err }, 'Stripe webhook handling failed');
      return reply.status(400).send({ ok: false, error: { code: 'webhook_error', message: String(err) } });
    }
  });

  // ── CRM webhooks ────────────────────────────────────────────────────────────
  server.post('/webhooks/hubspot', async (req: FastifyRequest, reply: FastifyReply) => {
    const result = parseHubSpot(req.body);
    if (result.error) {
      return reply.status(400).send({ ok: false, error: { code: 'invalid_hubspot_payload', message: result.error } });
    }
    if (!result.event) return reply.status(200).send({ ok: true, skipped: true });

    const tenantId = await resolveTenant(result.event);
    if (!tenantId) {
      logger.warn({ externalId: result.event.externalId }, 'HubSpot webhook: no tenant matched');
      return reply.status(200).send({ ok: true, tenantId: null, note: 'no_tenant_matched' });
    }
    await persistWebhookEvent(result.event, tenantId);
    return reply.status(201).send({ ok: true, tenantId, kind: result.event.kind });
  });

  server.post('/webhooks/salesforce', async (req: FastifyRequest, reply: FastifyReply) => {
    const result = parseSalesforce(req.body);
    if (result.error) {
      return reply.status(400).send({ ok: false, error: { code: 'invalid_salesforce_payload', message: result.error } });
    }
    if (!result.event) return reply.status(200).send({ ok: true, skipped: true });

    const tenantId = await resolveTenant(result.event);
    if (!tenantId) return reply.status(200).send({ ok: true, tenantId: null, note: 'no_tenant_matched' });

    await persistWebhookEvent(result.event, tenantId);
    return reply.status(201).send({ ok: true, tenantId, kind: result.event.kind });
  });

  server.post('/webhooks/notion', async (req: FastifyRequest, reply: FastifyReply) => {
    const result = parseNotion(req.body);
    if (result.error) {
      return reply.status(400).send({ ok: false, error: { code: 'invalid_notion_payload', message: result.error } });
    }
    if (!result.event) return reply.status(200).send({ ok: true, skipped: true });

    const tenantId = await resolveTenant(result.event);
    if (!tenantId) return reply.status(200).send({ ok: true, tenantId: null, note: 'no_tenant_matched' });

    await persistWebhookEvent(result.event, tenantId);
    return reply.status(201).send({ ok: true, tenantId, kind: result.event.kind });
  });
}
