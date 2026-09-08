// ── CRM integration routes (authenticated) ──────────────────────────────────
// POST   /v1/crm/integrations     — register a CRM object for inbound webhooks
// GET    /v1/crm/integrations     — list the tenant's registrations
// DELETE /v1/crm/integrations/:id — deactivate a registration
//
// The inbound webhook receivers live in routes/webhooks.ts (/webhooks/hubspot,
// /webhooks/salesforce, /webhooks/notion) and use these registrations to map
// a CRM object id → tenant without leaking cross-tenant data.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  registerIntegration,
  unregisterIntegration,
  listIntegrations,
} from '../../modules/crm/webhooks.js';
import type { CrmName } from '../../modules/crm/webhooks.js';

const VALID_CRMS: CrmName[] = ['HUBSPOT', 'SALESFORCE', 'NOTION'];

export async function crmRoutes(server: FastifyInstance) {
  server.post('/v1/crm/integrations', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const body = req.body as { crm?: string; externalId?: string };

    const crm = (body.crm ?? '').toUpperCase() as CrmName;
    const externalId = (body.externalId ?? '').trim();
    if (!VALID_CRMS.includes(crm)) {
      return reply.status(400).send({ ok: false, error: { code: 'invalid_crm', message: `crm must be one of ${VALID_CRMS.join(', ')}` } });
    }
    if (!externalId) {
      return reply.status(400).send({ ok: false, error: { code: 'missing_external_id', message: 'externalId is required' } });
    }

    const integration = await registerIntegration(tenant.id, crm, externalId);
    return reply.status(201).send({ ok: true, integration });
  });

  server.get('/v1/crm/integrations', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const integrations = await listIntegrations(tenant.id);
    return reply.send({ ok: true, integrations });
  });

  server.delete('/v1/crm/integrations/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const integration = await unregisterIntegration(tenant.id, id);
    if (!integration) {
      return reply.status(404).send({ ok: false, error: { code: 'integration_not_found' } });
    }
    return reply.send({ ok: true, integration });
  });
}
