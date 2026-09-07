import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config/index.js';
import { handleVerification, handleWebhook } from '../../channels/whatsapp/webhook.js';
import { processWebhookResult } from '../../modules/messages/pipeline.js';
import { logger } from '../../utils/logger.js';

export async function webhookRoutes(server: FastifyInstance) {
  // GET /webhooks/whatsapp — Meta subscription verification
  server.get('/webhooks/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>;
    const challenge = handleVerification(query, config.WHATSAPP_VERIFY_TOKEN);

    if (challenge !== null) {
      return reply.status(200).send(challenge);
    }

    return reply.status(403).send({ error: 'Verification failed' });
  });

  // POST /webhooks/whatsapp — Meta sends messages & status updates here
  server.post('/webhooks/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    const result = handleWebhook(rawBody, signature, config.META_APP_SECRET);

    if (!result) {
      return reply.status(401).send({ error: 'Signature verification failed' });
    }

    // Respond to Meta immediately, process in background
    reply.status(200).send({ status: 'received' });

    processWebhookResult(result).catch((err) => {
      logger.error({ err }, 'Background webhook processing failed');
    });
  });
}
