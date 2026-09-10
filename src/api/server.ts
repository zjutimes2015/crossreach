import Fastify from 'fastify';
import { fastifyStatic } from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webhookRoutes } from './routes/webhooks.js';
import { leadRoutes } from './routes/leads.js';
import { customerRoutes } from './routes/customers.js';
import { conversationRoutes } from './routes/conversations.js';
import { routingRoutes } from './routes/routing.js';
import { growthRoutes } from './routes/growth.js';
import { aiRoutes } from './routes/ai.js';
import { outreachRoutes } from './routes/outreach.js';
import { discoveryRoutes } from './routes/discovery.js';
import { billingRoutes } from './routes/billing.js';
import { connectRoutes } from './routes/connect.js';
import { stripeRoutes } from './routes/billing-stripe.js';
import { creemRoutes } from './routes/billing-creem.js';
import { authRoutes } from './routes/auth.js';
import { complianceRoutes } from './routes/compliance.js';
import { crmRoutes } from './routes/crm.js';
import { tenantMiddleware } from './middleware/tenant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const server = Fastify({ logger: false });

  // Preserve raw body string for webhook signature verification (HMAC-SHA256)
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as unknown as { rawBody: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Serve the commercial landing page at /
  await server.register(fastifyStatic, {
    root: path.resolve(__dirname, '../../public'),
    prefix: '/',
  });

  // Serve the React "Mission Control" dashboard at /dashboard/ (its own
  // encapsulation context so the sendFile reply decorator isn't re-added).
  server.get('/dashboard', async (_req, reply) => reply.redirect('/dashboard/'));
  await server.register(async (dashboard) => {
    await dashboard.register(fastifyStatic, {
      root: path.resolve(__dirname, '../../dashboard/dist'),
      prefix: '/dashboard/',
    });
  });

  // Health check
  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // Webhook routes — no auth, verified by HMAC signature / verify token
  await server.register(webhookRoutes);
  await server.register(leadRoutes);

  // Self-serve auth (signup / login / me) — registered OUTSIDE the
  // tenantMiddleware scope so no x-api-key is required. On success these
  // return the tenant API key which the dashboard stores for /v1/* calls.
  await server.register(authRoutes, { prefix: '/api/auth' });

  // API routes — require x-api-key header (tenant resolution)
  await server.register(
    async (api) => {
      api.addHook('onRequest', tenantMiddleware);
      await api.register(customerRoutes);
      await api.register(conversationRoutes);
      await api.register(routingRoutes);
      await api.register(growthRoutes);
      await api.register(aiRoutes);
      await api.register(outreachRoutes);
      await api.register(discoveryRoutes);
      await api.register(billingRoutes);
      await api.register(connectRoutes);
      await api.register(stripeRoutes);
      await api.register(creemRoutes);
      await api.register(crmRoutes);
      await api.register(complianceRoutes);
    },
    { prefix: '/api' },
  );

  return server;
}
