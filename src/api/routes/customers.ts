import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getCustomers,
  getCustomerById,
  updateCustomerStage,
  addTag,
} from '../../modules/customers/service.js';
import type { CustomerStage } from '@prisma/client';

export async function customerRoutes(server: FastifyInstance) {
  // GET /api/customers?stage=NEW&limit=50&offset=0
  server.get('/customers', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const query = req.query as {
      stage?: string;
      limit?: string;
      offset?: string;
    };

    const customers = await getCustomers(tenant.id, {
      stage: query.stage,
      limit: query.limit ? parseInt(query.limit) : undefined,
      offset: query.offset ? parseInt(query.offset) : undefined,
    });

    return reply.send({ customers });
  });

  // GET /api/customers/:id
  server.get('/customers/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };

    const customer = await getCustomerById(tenant.id, id);
    if (!customer) {
      return reply.status(404).send({ error: 'Customer not found' });
    }

    return reply.send({ customer });
  });

  // PATCH /api/customers/:id/stage  body: { stage: "QUALIFIED" }
  server.patch('/customers/:id/stage', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const { stage } = req.body as { stage: string };

    const customer = await updateCustomerStage(
      tenant.id,
      id,
      stage as CustomerStage,
    );
    return reply.send({ customer });
  });

  // POST /api/customers/:id/tags  body: { tag: "vip" }
  server.post('/customers/:id/tags', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const { tag } = req.body as { tag: string };

    const customer = await addTag(tenant.id, id, tag);
    if (!customer) {
      return reply.status(404).send({ error: 'Customer not found' });
    }

    return reply.send({ customer });
  });
}
