import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../db/prisma.js';
import {
  parseFacebookLead,
  parseTikTokLead,
  parseGoogleLead,
  processLead,
  verifyLeadWebhook,
} from '../../modules/growth/lead-import.js';
import { logger } from '../../utils/logger.js';

export async function leadRoutes(server: FastifyInstance) {
  // GET /webhooks/leads/:platform?hub.mode=subscribe&hub.verify_token=xxx&hub.challenge=yyy
  // Verifies the webhook subscription for a lead source
  server.get('/leads/:platform', async (req: FastifyRequest, reply: FastifyReply) => {
    const { platform } = req.params as { platform: string };
    const query = req.query as Record<string, string>;
    const verifyToken = query['hub.verify_token'];

    // Look up the lead source by verify token + platform
    const leadSource = await prisma.leadSource.findFirst({
      where: { verifyToken, platform: platform.toUpperCase() as never },
    });

    if (!leadSource) {
      return reply.status(404).send({ error: 'Lead source not found' });
    }

    const challenge = verifyLeadWebhook(query, leadSource.verifyToken);
    if (challenge !== null) {
      return reply.status(200).send(challenge);
    }
    return reply.status(403).send({ error: 'Verification failed' });
  });

  // POST /webhooks/leads/:platform
  // Receives ad lead notifications; platform determines the parser
  server.post('/leads/:platform', async (req: FastifyRequest, reply: FastifyReply) => {
    const { platform } = req.params as { platform: string };
    const body = req.body as unknown;
    const query = req.query as { verifyToken?: string };

    // 1. Resolve the lead source
    const leadSource = await prisma.leadSource.findFirst({
      where: { verifyToken: query.verifyToken, platform: platform.toUpperCase() as never },
    });

    if (!leadSource) {
      return reply.status(404).send({ error: 'Lead source not found' });
    }

    // 2. Parse the lead using the platform-specific parser
    let lead = null;
    switch (platform.toLowerCase()) {
      case 'facebook':
        lead = parseFacebookLead(body);
        break;
      case 'tiktok':
        lead = parseTikTokLead(body);
        break;
      case 'google':
        lead = parseGoogleLead(body);
        break;
      default:
        return reply.status(400).send({ error: `Unknown platform: ${platform}` });
    }

    if (!lead) {
      logger.warn({ platform }, 'Failed to parse lead payload');
      return reply.status(200).send({ status: 'ignored', reason: 'unparseable' });
    }

    // 3. Respond immediately, process in background
    reply.status(200).send({ status: 'received' });

    processLead(leadSource.tenantId, lead).catch((err) => {
      logger.error({ err, platform }, 'Lead processing failed');
    });
  });
}
