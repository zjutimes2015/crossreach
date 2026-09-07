import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../db/prisma.js';
import {
  generateOutreachContent,
  renderTemplate,
} from '../../modules/ai/content-generator.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_WHATSAPP_PROMPT,
  DEFAULT_EMAIL_PROMPT,
} from '../../modules/ai/content-generator.js';
import type { ChannelType } from '@prisma/client';

export async function aiRoutes(server: FastifyInstance) {
  // ── AI Content Templates CRUD ───────────────────────────────────────────

  // GET /api/ai/templates
  server.get('/ai/templates', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const templates = await prisma.aIContentTemplate.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ templates });
  });

  // POST /api/ai/templates — create a content generation template
  server.post('/ai/templates', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as {
      name: string;
      channel: ChannelType;
      systemPrompt: string;
      userPrompt: string;
      language?: string;
      maxTokens?: number;
    };

    const template = await prisma.aIContentTemplate.create({
      data: {
        tenantId: tenant.id,
        name: body.name,
        channel: body.channel,
        systemPrompt: body.systemPrompt,
        userPrompt: body.userPrompt,
        language: body.language ?? 'en_US',
        maxTokens: body.maxTokens ?? 200,
      },
    });

    return reply.status(201).send({ template });
  });

  // DELETE /api/ai/templates/:id
  server.delete('/ai/templates/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    await prisma.aIContentTemplate.deleteMany({ where: { id, tenantId: tenant.id } });
    return reply.status(204).send();
  });

  // ── Content generation ────────────────────────────────────────────────────

  // POST /api/ai/generate — generate personalized outreach for a customer
  // Body: { templateId, customerId, researchNotes?, sellerInfo? }
  server.post('/ai/generate', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as {
      templateId: string;
      customerId: string;
      researchNotes?: string;
      sellerInfo?: Record<string, string>;
    };

    const aiTemplate = await prisma.aIContentTemplate.findFirst({
      where: { id: body.templateId, tenantId: tenant.id },
    });

    if (!aiTemplate) {
      return reply.status(404).send({ error: 'AI template not found' });
    }

    const customer = await prisma.customer.findFirst({
      where: { id: body.customerId, tenantId: tenant.id },
    });

    if (!customer) {
      return reply.status(404).send({ error: 'Customer not found' });
    }

    const generated = await generateOutreachContent(aiTemplate, {
      customer: {
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        source: customer.source,
        tags: customer.tags,
        attributes: customer.attributes,
      },
      researchNotes: body.researchNotes,
      sellerInfo: body.sellerInfo,
    });

    return reply.send({ content: generated });
  });

  // POST /api/ai/preview — preview rendered prompt without LLM call
  server.post('/ai/preview', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as {
      templateId: string;
      customerId: string;
    };

    const aiTemplate = await prisma.aIContentTemplate.findFirst({
      where: { id: body.templateId, tenantId: tenant.id },
    });
    if (!aiTemplate) return reply.status(404).send({ error: 'Template not found' });

    const customer = await prisma.customer.findFirst({
      where: { id: body.customerId, tenantId: tenant.id },
    });
    if (!customer) return reply.status(404).send({ error: 'Customer not found' });

    const ctx = {
      customer: {
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        source: customer.source,
        tags: customer.tags,
        attributes: customer.attributes,
      },
    };

    return reply.send({
      systemPrompt: renderTemplate(aiTemplate.systemPrompt, ctx),
      userPrompt: renderTemplate(aiTemplate.userPrompt, ctx),
    });
  });

  // GET /api/ai/defaults — returns the default prompt templates (for UI seeding)
  server.get('/ai/defaults', async () => ({
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    templates: {
      whatsapp: DEFAULT_WHATSAPP_PROMPT,
      email: DEFAULT_EMAIL_PROMPT,
    },
  }));
}
