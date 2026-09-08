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
import {
  recordEmailEvent,
  TRANS_PIXEL,
} from '../../email/tracking.js';
import { parseBounceWebhook } from '../../email/bounce.js';
import { applyBounceFeedback } from '../../email/deliverability.js';
import type { ParsedFeedbackEvent } from '../../email/bounce.js';
import { prisma } from '../../db/prisma.js';
import type { ConnectAccount } from '@prisma/client';

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

  // ── Email delivery feedback (bounce / complaint / delivered / open / click) ─
  server.post('/webhooks/email/bounce', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseBounceWebhook(req.body);
    if (!parsed.ok) {
      return reply.status(400).send({ ok: false, error: { code: 'invalid_email_bounce_payload', message: parsed.error } });
    }
    // Confirm receipt before doing work so providers don't retry on a slow DB.
    reply.status(200).send({ ok: true, provider: parsed.provider, events: parsed.events.length });

    for (const ev of parsed.events) {
      try {
        // Bounces/complaints get attributed to a sending account so its health
        // can be adjusted (and paused if it breaches a threshold). Vanilla
        // positive signals (open/click/delivered/unsubscribe) just get logged.
        const negative = ev.type === 'BOUNCED_HARD' || ev.type === 'BOUNCED_SOFT' || ev.type === 'COMPLAINED';
        const account = negative ? await resolveEmailAccount(ev) : null;
        if (account) {
          await applyBounceFeedback(account, {
            type: ev.type,
            recipient: ev.recipient,
            messageId: ev.messageId,
            smtpCode: ev.smtpCode,
            detail: ev.detail,
          });
        } else {
          await recordEmailEvent({
            type: ev.type,
            recipient: ev.recipient,
            messageId: ev.messageId,
            smtpCode: ev.smtpCode,
            detail: ev.detail,
          });
        }
      } catch (err) {
        logger.error({ err, event: ev.type }, 'Email feedback event handling failed');
      }
    }
  });

  // ── Email tracking endpoints (no auth — the opaque token is the credential) ─
  // Open pixel: transparent GIF, records OPENED without blocking the response.
  server.get('/_track/:token/open.gif', async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = req.params as { token: string };
    void recordEmailEvent({ token, type: 'OPENED' }).catch((err) =>
      logger.warn({ err, token }, 'open event record failed'),
    );
    return reply.type('image/gif').send(TRANS_PIXEL);
  });

  // Click-through redirect: records CLICKED then follows the original URL.
  server.get('/_track/:token/click', async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = req.params as { token: string };
    const url = (req.query as { url?: string }).url;
    await recordEmailEvent({ token, type: 'CLICKED' }).catch((err) =>
      logger.warn({ err, token }, 'click event record failed'),
    );
    // Only allow http(s) targets (no open-redirect on the same host).
    if (url && /^https?:\/\//i.test(url)) return reply.redirect(url);
    return reply.redirect('/');
  });

  // Unsubscribe: flips the token terminal and records the event.
  server.get('/_track/:token/unsubscribe', async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = req.params as { token: string };
    await recordEmailEvent({ token, type: 'UNSUBSCRIBED' }).catch((err) =>
      logger.warn({ err, token }, 'unsubscribe event record failed'),
    );
    await prisma.emailTrackingToken
      .updateMany({ where: { token }, data: { unsubscribed: true } })
      .catch(() => {});
    return reply.type('text/html').send('<p>You have been unsubscribed.</p>');
  });
}

// ── Attribution helper: bounce → the sending account for that recipient ─────
async function resolveEmailAccount(
  ev: ParsedFeedbackEvent,
): Promise<ConnectAccount | null> {
  if (!ev.recipient) return null;
  const token = await prisma.emailTrackingToken.findFirst({
    where: { recipient: ev.recipient },
    orderBy: { createdAt: 'desc' },
  });
  if (!token?.accountId) return null;
  return prisma.connectAccount.findUnique({ where: { id: token.accountId } });
}
