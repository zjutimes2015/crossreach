// ── CRM Webhook sync module ──────────────────────────────────────────────────
// Receives inbound CRM events (Deal, Contact, Lead) and routes them into a
// CrossReach tenant's event log for downstream CDP processing.
//
// Tenant resolution: a tenant first registers its CRM objects via
// POST /api/v1/crm/integrations { crm, externalId } (authenticated). Inbound
// webhooks then map (crm, externalId) → tenant. No unauthenticated tenant
// guessing is ever attempted.
//
// Supported CRMs:
//   HubSpot    — deals / contacts / tickets / companies
//   Salesforce — opportunities / leads / cases
//   Notion     — page updates (lightweight CRM tracking)

import { logger } from '../../utils/logger.js';
import { prisma } from '../../db/prisma.js';

export type CrmKind =
  | 'deal.created'
  | 'deal.updated'
  | 'contact.created'
  | 'contact.updated'
  | 'lead.created'
  | 'lead.updated';

export type CrmName = 'HUBSPOT' | 'SALESFORCE' | 'NOTION';

export interface CrmEvent {
  kind: CrmKind;
  crm: CrmName;
  externalId: string;
  object: Record<string, unknown>;
}

export interface ParseResult {
  event: CrmEvent | null;
  error?: string;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export function parseHubSpot(payload: unknown): ParseResult {
  const body = (payload as Record<string, unknown>) ?? {};
  const props = (body.properties ?? {}) as Record<string, unknown>;
  const kind = detectHubSpotKind(body);
  if (!kind) return { event: null, error: 'unrecognized hubspot object type' };

  const externalId = String(body.objectId ?? body.id ?? '');
  if (!externalId) return { event: null, error: 'hubspot payload missing objectId' };

  return {
    event: {
      kind,
      crm: 'HUBSPOT',
      externalId,
      object: {
        type: String(body.objectType ?? ''),
        properties: props,
        company: body.company ?? null,
        changeSource: body.changeSource ?? null,
        occurredAt: body.occurredAt ?? null,
      },
    },
  };
}

function detectHubSpotKind(body: Record<string, unknown>): CrmKind | null {
  const objectType = String(body.objectType ?? '').toLowerCase();
  const props = (body.properties ?? {}) as Record<string, unknown>;
  switch (objectType) {
    case 'deal':
      return props.closedate || props.dealstage ? 'deal.updated' : 'deal.created';
    case 'contact':
      return 'contact.created';
    case 'ticket':
      return 'contact.updated';
    case 'company':
      return 'deal.updated';
    default:
      // Some HubSpot builds omit objectType but include deal-stage props
      if (props.dealstage !== undefined) return 'deal.updated';
      if (props.email !== undefined) return 'contact.created';
      return null;
  }
}

export function parseSalesforce(payload: unknown): ParseResult {
  const body = (payload as Record<string, unknown>) ?? {};
  // Salesforce Change Data Capture (CometD) envelopes events as
  // { event, payload: { ChangeEventHeader: { entityName }, <fields> } }.
  // Composite REST webhooks send flat objects. Normalize both shapes.
  const data = (body.payload as Record<string, unknown>) ?? body;
  const changeHeader = (data.ChangeEventHeader ?? {}) as Record<string, unknown>;

  const entityName = String(
    changeHeader.entityName ?? data.sfobject ?? data.objectType ?? body.sfobject ?? body.objectType ?? '',
  );
  const kind = detectSfKind(entityName, data, body);
  if (!kind) return { event: null, error: 'unrecognized salesforce object type' };

  const externalId = String(data.Id ?? data.id ?? data.sfid ?? body.Id ?? body.id ?? body.sfid ?? '');
  if (!externalId) return { event: null, error: 'salesforce payload missing id' };

  const eventType = String(
    body.EventType ?? body.eventType ?? changeHeader.changeType ?? '',
  );

  return {
    event: {
      kind,
      crm: 'SALESFORCE',
      externalId,
      object: {
        sfObject: entityName || null,
        eventType,
        fields: data,
      },
    },
  };
}

function detectSfKind(
  sfObject: string,
  data: Record<string, unknown>,
  body: Record<string, unknown>,
): CrmKind | null {
  const entity = sfObject.replace(/ChangeEvent$/i, '').toLowerCase();
  const eventType = String(
    body.EventType ?? body.eventType ?? ((data.ChangeEventHeader as Record<string, unknown>)?.changeType ?? ''),
  ).toLowerCase();
  // Salesforce changeType: CREATE / UPDATE / DELETE. Empty or CREATE ⇒ a new
  // record; anything else (UPDATE, afterChange, …) is treated as an update.
  const isCreate = eventType === '' || eventType === 'create' || eventType.includes('created');
  const isUpdate = !isCreate;
  switch (entity) {
    case 'opportunity':
    case 'deal':
      return isUpdate ? 'deal.updated' : 'deal.created';
    case 'lead':
      return isUpdate ? 'lead.updated' : 'lead.created';
    case 'contact':
      return isUpdate ? 'contact.updated' : 'contact.created';
    case 'case':
      return 'contact.updated';
    default:
      return null;
  }
}

export function parseNotion(payload: unknown): ParseResult {
  const body = (payload ?? {}) as Record<string, unknown>;
  const event = body.event as Record<string, unknown> | undefined;
  const eventType = String(body.type ?? event?.type ?? '');
  if (!['page_update', 'page_create', 'page_updated'].includes(eventType)) {
    return { event: null };
  }

  const page = ((body.page ?? body.object) ?? {}) as Record<string, unknown>;
  const externalId = String(page.id ?? body.id ?? '');
  if (!externalId) return { event: null, error: 'notion payload missing page id' };

  return {
    event: {
      kind: eventType === 'page_create' ? 'deal.created' : 'deal.updated',
      crm: 'NOTION',
      externalId,
      object: { page, eventType },
    },
  };
}

// ── Tenant resolution ────────────────────────────────────────────────────────

export async function resolveTenant(crmEvent: CrmEvent): Promise<string | null> {
  const row = await prisma.crmIntegration.findFirst({
    where: { crm: crmEvent.crm, externalId: crmEvent.externalId, active: true },
    select: { tenantId: true },
  });
  return row?.tenantId ?? null;
}

// ── Persist inbound webhook event ────────────────────────────────────────────

export async function persistWebhookEvent(
  crmEvent: CrmEvent,
  tenantId: string,
): Promise<void> {
  await prisma.webhookEvent.create({
    data: {
      tenantId,
      source: crmEvent.crm,
      externalId: crmEvent.externalId,
      kind: crmEvent.kind,
      payload: crmEvent.object as object,
      processed: false,
    },
  });
  logger.info(
    { tenantId, crm: crmEvent.crm, kind: crmEvent.kind, externalId: crmEvent.externalId },
    'CRM webhook event persisted',
  );
}

// ── Integration registration (authenticated) ─────────────────────────────────

export async function registerIntegration(tenantId: string, crm: CrmName, externalId: string) {
  const integration = await prisma.crmIntegration.upsert({
    where: { crm_externalId: { crm, externalId } },
    create: { tenantId, crm, externalId, active: true },
    update: { tenantId, active: true },
  });
  return integration;
}

export async function unregisterIntegration(tenantId: string, id: string) {
  const integration = await prisma.crmIntegration.findFirst({ where: { id, tenantId } });
  if (!integration) return null;
  return prisma.crmIntegration.update({ where: { id }, data: { active: false } });
}

export async function listIntegrations(tenantId: string) {
  return prisma.crmIntegration.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
}
