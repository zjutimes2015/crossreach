import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import { sendWhatsAppMessage } from '../../channels/whatsapp/api.js';
import type { WhatsAppChannelConfig } from '../../channels/types.js';
import type { Customer, Campaign } from '@prisma/client';

// ── Recipient filter definition ───────────────────────────────────────────

export interface RecipientFilter {
  stage?: string; // CustomerStage enum value
  tags?: string[]; // customer must have ANY of these tags
  source?: string; // e.g. "facebook_lead"
  // Only include customers last seen within N days (0 = no limit)
  lastSeenWithinDays?: number;
}

// ── Resolve recipients from a filter ──────────────────────────────────────

async function resolveRecipients(
  tenantId: string,
  filter: RecipientFilter,
): Promise<Customer[]> {
  const where: Record<string, unknown> = { tenantId };

  if (filter.stage) where.stage = filter.stage;
  if (filter.source) where.source = filter.source;
  if (filter.tags && filter.tags.length > 0) {
    where.tags = { hasSome: filter.tags };
  }
  if (filter.lastSeenWithinDays && filter.lastSeenWithinDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - filter.lastSeenWithinDays);
    where.lastSeenAt = { gte: cutoff };
  }

  return prisma.customer.findMany({ where });
}

// ── Create a broadcast campaign (DRAFT status, pre-computes recipients) ───

export async function createCampaign(params: {
  tenantId: string;
  name: string;
  channelId: string;
  templateName: string;
  language?: string;
  components?: unknown[];
  filter: RecipientFilter;
}): Promise<{ campaign: Campaign; recipientCount: number }> {
  // 1. Resolve recipients upfront so we can report the count
  const recipients = await resolveRecipients(params.tenantId, params.filter);

  // 2. Create campaign + recipient records in a transaction
  const campaign = await prisma.campaign.create({
    data: {
      tenantId: params.tenantId,
      name: params.name,
      channelId: params.channelId,
      templateName: params.templateName,
      language: params.language ?? 'en_US',
      components: (params.components ?? []) as object,
      filter: params.filter as object,
      status: 'DRAFT',
      totalRecipients: recipients.length,
      recipients: {
        create: recipients.map((c) => ({
          tenantId: params.tenantId,
          customerId: c.id,
          status: 'PENDING',
        })),
      },
    },
  });

  logger.info(
    { campaignId: campaign.id, recipientCount: recipients.length },
    'Campaign created (DRAFT)',
  );

  return { campaign, recipientCount: recipients.length };
}

// ── Start a campaign: send template to all recipients in batches ──────────

const BATCH_SIZE = 50; // messages per batch
const BATCH_DELAY_MS = 1000; // delay between batches to respect rate limits

export async function startCampaign(
  tenantId: string,
  campaignId: string,
): Promise<{ started: boolean; sent: number; failed: number }> {
  // 1. Load campaign + channel config
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, tenantId },
    include: {
      channel: true,
      recipients: { where: { status: 'PENDING' } },
    },
  });

  if (!campaign) {
    logger.warn({ campaignId }, 'Campaign not found');
    return { started: false, sent: 0, failed: 0 };
  }

  if (campaign.status !== 'DRAFT' && campaign.status !== 'PAUSED') {
    logger.warn({ campaignId, status: campaign.status }, 'Campaign cannot be started');
    return { started: false, sent: 0, failed: 0 };
  }

  // Mark as RUNNING
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  const channelConfig = campaign.channel.config as unknown as WhatsAppChannelConfig;
  const components = (campaign.components as unknown[]) ?? undefined;

  let sent = 0;
  let failed = 0;

  // 2. Process recipients in batches
  const pending = campaign.recipients;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);

    // Send each recipient in the batch concurrently
    await Promise.all(
      batch.map(async (recipient) => {
        // Load the customer to get externalId (phone number)
        const customer = await prisma.customer.findUnique({
          where: { id: recipient.customerId },
        });

        if (!customer) {
          await prisma.campaignRecipient.update({
            where: { id: recipient.id },
            data: { status: 'SKIPPED', error: 'Customer not found' },
          });
          return;
        }

        const result = await sendWhatsAppMessage(channelConfig, {
          to: customer.externalId,
          content: {
            kind: 'template',
            templateName: campaign.templateName,
            language: campaign.language,
            components,
          },
        });

        if (result.status === 'sent') {
          sent++;
          await prisma.campaignRecipient.update({
            where: { id: recipient.id },
            data: {
              status: 'SENT',
              externalMessageId: result.externalMessageId,
              sentAt: new Date(),
            },
          });
        } else {
          failed++;
          await prisma.campaignRecipient.update({
            where: { id: recipient.id },
            data: { status: 'FAILED', error: 'WhatsApp API send failed' },
          });
        }
      }),
    );

    // Increment campaign counters
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { sentCount: { increment: sent }, failedCount: { increment: failed } },
    });

    // Rate-limit pause between batches (except after the last batch)
    if (i + BATCH_SIZE < pending.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // 3. Mark as completed
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });

  logger.info(
    { campaignId, sent, failed, total: pending.length },
    'Campaign completed',
  );

  return { started: true, sent, failed };
}

// ── Query campaigns ───────────────────────────────────────────────────────

export async function getCampaigns(tenantId: string) {
  return prisma.campaign.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    include: { channel: { select: { id: true, name: true, type: true } } },
  });
}

export async function getCampaignStats(tenantId: string, campaignId: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, tenantId },
    include: {
      _count: {
        select: {
          recipients: {
            where: { status: 'SENT' },
          },
        },
      },
    },
  });
  return campaign;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
