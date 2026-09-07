import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createRoutingRule,
  getRoutingRules,
  deleteRoutingRule,
} from '../../modules/routing/service.js';
import type { MatchType, AssignStrategy } from '@prisma/client';

export async function routingRoutes(server: FastifyInstance) {
  // GET /api/routing/rules
  server.get('/routing/rules', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const rules = await getRoutingRules(tenant.id);
    return reply.send({ rules });
  });

  // POST /api/routing/rules
  server.post('/routing/rules', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as {
      name: string;
      priority: number;
      matchType: MatchType;
      matchValue: string;
      strategy: AssignStrategy;
      targetAgentId?: string;
      targetSkillGroupId?: string;
    };

    const rule = await createRoutingRule({
      tenantId: tenant.id,
      name: body.name,
      priority: body.priority,
      matchType: body.matchType,
      matchValue: body.matchValue,
      strategy: body.strategy,
      targetAgentId: body.targetAgentId,
      targetSkillGroupId: body.targetSkillGroupId,
    });

    return reply.status(201).send({ rule });
  });

  // DELETE /api/routing/rules/:id
  server.delete('/routing/rules/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    await deleteRoutingRule(tenant.id, id);
    return reply.status(204).send();
  });
}
