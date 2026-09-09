import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import { findOrCreateCustomer } from '../customers/service.js';
import { findOrCreateConversation } from '../conversations/service.js';
import { sendMessage } from '../messages/service.js';
import { enrollInSequence } from './sequences.js';
import { notifyTeamAsync } from '../notifications/im.js';
import type { LeadPlatform } from '@prisma/client';

// ── Unified lead shape (normalized from all ad platforms) ─────────────────

export interface ParsedLead {
  platform: LeadPlatform;
  // The phone number is the key — it becomes the WhatsApp recipient
  phone: string;
  name?: string;
  email?: string;
  // Custom form fields (e.g. { product_interest: "widgets", country: "USA" })
  fields?: Record<string, string>;
  // Original raw payload for audit
  rawPayload: unknown;
  // Identifier used to look up the LeadSource (form_id, page_id, etc.)
  sourceIdentifier: string;
}

// ── Platform-specific parsers ─────────────────────────────────────────────

/**
 * Facebook Lead Forms webhook payload.
 * Entry → changes → value → leadgen: { form_id, leadgen_id, field_data: [...] }
 */
export function parseFacebookLead(payload: unknown): ParsedLead | null {
  const p = payload as {
    object?: string;
    entry?: Array<{
      changes?: Array<{
        value?: {
          form_id?: string;
          leadgen_id?: string;
          page_id?: string;
          field_data?: Array<{ name: string; values: string[] }>;
        };
      }>;
    }>;
  };

  if (p.object !== 'page') return null;

  const change = p.entry?.[0]?.changes?.[0]?.value;
  if (!change?.form_id || !change.field_data) return null;

  // Flatten field_data into a key→value map, extract phone/name/email
  const fields: Record<string, string> = {};
  for (const f of change.field_data) {
    fields[f.name] = f.values?.[0] ?? '';
  }

  // Facebook form field names are configurable; try common keys
  const phone =
    fields.phone ||
    fields.phone_number ||
    fields.mobile ||
    fields.whatsapp ||
    '';
  const name = fields.full_name || fields.first_name || fields.name || undefined;
  const email = fields.email || fields.work_email || undefined;

  if (!phone) {
    logger.warn({ formId: change.form_id }, 'Facebook lead has no phone field');
    return null;
  }

  return {
    platform: 'FACEBOOK',
    phone: normalizePhone(phone),
    name,
    email,
    fields,
    rawPayload: payload,
    sourceIdentifier: change.form_id,
  };
}

/**
 * TikTok Lead Gen webhook payload (simplified).
 */
export function parseTikTokLead(payload: unknown): ParsedLead | null {
  const p = payload as {
    event?: string;
    data?: {
      form_id?: string;
      lead_id?: string;
      field_data?: Array<{ field_name: string; value: string }>;
    };
  };

  if (p.event !== 'lead_generated' || !p.data?.form_id) return null;

  const fields: Record<string, string> = {};
  for (const f of p.data.field_data ?? []) {
    fields[f.field_name] = f.value;
  }

  const phone = fields.phone || fields.phone_number || fields.mobile || '';
  const name = fields.full_name || fields.name || undefined;
  const email = fields.email || undefined;

  if (!phone) {
    logger.warn({ formId: p.data.form_id }, 'TikTok lead has no phone field');
    return null;
  }

  return {
    platform: 'TIKTOK',
    phone: normalizePhone(phone),
    name,
    email,
    fields,
    rawPayload: payload,
    sourceIdentifier: p.data.form_id,
  };
}

/**
 * Google Lead Form webhook payload (simplified).
 */
export function parseGoogleLead(payload: unknown): ParsedLead | null {
  const p = payload as {
    lead_form_id?: string;
    user_column_data?: Array<{ column_id: string; string_value: string }>;
  };

  if (!p.lead_form_id) return null;

  // Google column IDs: "Phone Number"=PHONE_NUMBER, "Full Name"=FULL_NAME, "Email"=EMAIL
  const fields: Record<string, string> = {};
  for (const c of p.user_column_data ?? []) {
    fields[c.column_id] = c.string_value;
  }

  const phone = fields.PHONE_NUMBER || fields.phone || '';
  const name = fields.FULL_NAME || fields.name || undefined;
  const email = fields.EMAIL || fields.email || undefined;

  if (!phone) {
    logger.warn({ formId: p.lead_form_id }, 'Google lead has no phone field');
    return null;
  }

  return {
    platform: 'GOOGLE',
    phone: normalizePhone(phone),
    name,
    email,
    fields,
    rawPayload: payload,
    sourceIdentifier: p.lead_form_id,
  };
}

// ── Normalize phone to E.164-ish format (WhatsApp requires country code) ──

function normalizePhone(phone: string): string {
  // Strip spaces, dashes, parens; ensure leading +
  let cleaned = phone.replace(/[\s\-()]/g, '');
  if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  return cleaned;
}

// ── Process a parsed lead: create customer, send welcome, enroll sequence ─

export async function processLead(
  tenantId: string,
  lead: ParsedLead,
): Promise<{ success: boolean; customerId?: string; error?: string }> {
  // 1. Find the matching LeadSource by platform + sourceIdentifier
  const leadSource = await prisma.leadSource.findFirst({
    where: {
      tenantId,
      platform: lead.platform,
      isActive: true,
      config: { path: ['formId'], equals: lead.sourceIdentifier },
    },
  });

  if (!leadSource) {
    logger.warn(
      { tenantId, platform: lead.platform, sourceIdentifier: lead.sourceIdentifier },
      'No matching LeadSource for incoming lead',
    );
    return { success: false, error: 'No matching lead source' };
  }

  // 2. Find or create the customer (externalId = phone for WhatsApp leads)
  const customer = await findOrCreateCustomer({
    tenantId,
    externalId: lead.phone,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    source: `${lead.platform.toLowerCase()}_lead`,
  });

  // Store custom fields as attributes
  if (lead.fields) {
    await prisma.customer.update({
      where: { id: customer.id },
      data: { attributes: lead.fields as object },
    });
  }

  // 3. Send welcome template (if configured on the lead source)
  if (leadSource.welcomeTemplate) {
    const channel = await prisma.channel.findFirst({
      where: { tenantId, type: 'WHATSAPP', isActive: true },
    });

    if (channel) {
      const conversation = await findOrCreateConversation({
        tenantId,
        customerId: customer.id,
        channelId: channel.id,
      });

      await sendMessage({
        tenantId,
        conversationId: conversation.id,
        content: {
          kind: 'template',
          templateName: leadSource.welcomeTemplate,
          language: leadSource.welcomeLanguage ?? 'en_US',
        },
      });

      logger.info(
        { customerId: customer.id, template: leadSource.welcomeTemplate },
        'Welcome template sent to new lead',
      );
    }
  }

  // 4. Auto-enroll in follow-up sequence (if configured)
  if (leadSource.autoSequenceId) {
    await enrollInSequence(tenantId, leadSource.autoSequenceId, customer.id);
    logger.info(
      { customerId: customer.id, sequenceId: leadSource.autoSequenceId },
      'Lead auto-enrolled in follow-up sequence',
    );
  }

  logger.info(
    { tenantId, customerId: customer.id, platform: lead.platform },
    'Lead processed successfully',
  );

  // Alert the team so a hot lead gets a quick response.
  notifyTeamAsync({
    title: `🆕 New ${lead.platform} lead`,
    text: `${lead.name ?? 'Prospect'} (${lead.phone})${
      lead.fields?.country ? ` · ${lead.fields.country}` : ''
    } was enrolled and is awaiting engagement.`,
  });

  return { success: true, customerId: customer.id };
}

/**
 * Verify a lead source webhook subscription (FB-style GET verification).
 */
export function verifyLeadWebhook(
  query: Record<string, string>,
  verifyToken: string,
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken) {
    return challenge;
  }
  return null;
}
