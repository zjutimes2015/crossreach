import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../db/prisma.js';
import type { Tenant } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant;
  }
}

/**
 * Resolve the tenant from the x-api-key header.
 * Attached to req.tenant for downstream handlers.
 */
export async function tenantMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || typeof apiKey !== 'string') {
    return reply.status(401).send({ error: 'Missing x-api-key header' });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { apiKey },
  });

  if (!tenant || tenant.status === 'SUSPENDED') {
    return reply.status(401).send({ error: 'Invalid or suspended API key' });
  }

  req.tenant = tenant;
}
