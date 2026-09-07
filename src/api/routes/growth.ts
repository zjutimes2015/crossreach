import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createCampaign,
  startCampaign,
  getCampaigns,
  getCampaignStats,
} from '../../modules/growth/broadcast.js';
import type { RecipientFilter } from '../../modules/growth/broadcast.js';
import {
  createSequence,
  getSequences,
  getSequenceById,
  enrollInSequence,
} from '../../modules/growth/sequences.js';
import type { StepActionType } from '@prisma/client';

export async function growthRoutes(server: FastifyInstance) {
  // ── Campaigns (批量触达) ────────────────────────────────────────────────

  // GET /api/campaigns
  server.get('/campaigns', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const campaigns = await getCampaigns(tenant.id);
    return reply.send({ campaigns });
  });

  // POST /api/campaigns  — create a broadcast campaign (DRAFT)
  server.post('/campaigns', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as {
      name: string;
      channelId: string;
      templateName: string;
      language?: string;
      components?: unknown[];
      filter: RecipientFilter;
    };

    const result = await createCampaign({
      tenantId: tenant.id,
      name: body.name,
      channelId: body.channelId,
      templateName: body.templateName,
      language: body.language,
      components: body.components,
      filter: body.filter,
    });

    return reply.status(201).send(result);
  });

  // POST /api/campaigns/:id/start — start sending (runs in background)
  server.post('/campaigns/:id/start', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };

    // Respond immediately, process in background
    reply.send({ status: 'starting', campaignId: id });

    startCampaign(tenant.id, id).catch((err) => {
      req.log.error({ err, campaignId: id }, 'Campaign execution failed');
    });
  });

  // GET /api/campaigns/:id/stats
  server.get('/campaigns/:id/stats', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const stats = await getCampaignStats(tenant.id, id);
    return reply.send({ campaign: stats });
  });

  // ── Sequences (跟进序列) ────────────────────────────────────────────────

  // GET /api/sequences
  server.get('/sequences', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const sequences = await getSequences(tenant.id);
    return reply.send({ sequences });
  });

  // GET /api/sequences/:id
  server.get('/sequences/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const sequence = await getSequenceById(tenant.id, id);
    if (!sequence) return reply.status(404).send({ error: 'Sequence not found' });
    return reply.send({ sequence });
  });

  // POST /api/sequences — create a sequence with cross-channel steps
  server.post('/sequences', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as {
      name: string;
      description?: string;
      channelId?: string;
      steps: Array<{
        stepNumber: number;
        delayMinutes: number;
        channelId?: string;
        actionType?: StepActionType;
        templateName?: string;
        language?: string;
        components?: unknown[];
        emailSubject?: string;
        emailBody?: string;
        linkedinTarget?: string;
        aiTemplateId?: string;
        stopIfReplied?: boolean;
      }>;
    };

    const sequence = await createSequence({
      tenantId: tenant.id,
      name: body.name,
      description: body.description,
      channelId: body.channelId,
      steps: body.steps,
    });

    return reply.status(201).send({ sequence });
  });

  // POST /api/sequences/:id/enroll — manually enroll a customer
  server.post('/sequences/:id/enroll', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const { customerId } = req.body as { customerId: string };

    const enrollment = await enrollInSequence(tenant.id, id, customerId);
    if (!enrollment) {
      return reply.status(400).send({ error: 'Cannot enroll (sequence inactive or no steps)' });
    }

    return reply.status(201).send({ enrollment });
  });
}
