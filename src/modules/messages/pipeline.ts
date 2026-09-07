import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import type {
  ParsedInboundMessage,
  ParsedStatusUpdate,
} from '../../channels/types.js';
import { findOrCreateCustomer } from '../customers/service.js';
import { findOrCreateConversation } from '../conversations/service.js';
import { routeConversation } from '../routing/service.js';
import { stopEnrollment } from '../growth/sequences.js';
import type { MessageType, MessageStatus } from '@prisma/client';

// Map WhatsApp message types → Prisma MessageType enum
const messageTypeMap: Record<string, MessageType> = {
  text: 'TEXT',
  image: 'IMAGE',
  audio: 'AUDIO',
  video: 'VIDEO',
  document: 'DOCUMENT',
  location: 'LOCATION',
  button: 'INTERACTIVE',
  interactive: 'INTERACTIVE',
};

/**
 * Process a single inbound message:
 * 1. Look up channel by phone_number_id
 * 2. Find or create customer
 * 3. Find or create conversation
 * 4. Store the message
 * 5. Update conversation + customer timestamps
 */
export async function processInboundMessage(msg: ParsedInboundMessage): Promise<void> {
  // 1. Find the channel by the phone_number_id in the webhook metadata
  const channel = await prisma.channel.findFirst({
    where: {
      type: 'WHATSAPP',
      isActive: true,
      config: { path: ['phoneNumberId'], equals: msg.channelIdentifier },
    },
  });

  if (!channel) {
    logger.warn(
      { channelIdentifier: msg.channelIdentifier },
      'No active WhatsApp channel found for inbound message',
    );
    return;
  }

  // 2. Find or create the customer
  const customer = await findOrCreateCustomer({
    tenantId: channel.tenantId,
    externalId: msg.externalCustomerId,
    name: msg.customerName,
    phone: msg.externalCustomerId,
    source: 'WHATSAPP',
  });

  // 3. Find or create the conversation
  const conversation = await findOrCreateConversation({
    tenantId: channel.tenantId,
    customerId: customer.id,
    channelId: channel.id,
  });

  // 4. Store the message
  await prisma.message.create({
    data: {
      tenantId: channel.tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      direction: 'INBOUND',
      type: messageTypeMap[msg.type] ?? 'TEXT',
      content: msg.content as object,
      rawPayload: msg.rawPayload as object,
      status: 'SENT' as MessageStatus,
    },
  });

  // 5. Update conversation lastMessageAt
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: msg.timestamp },
  });

  // 6. Update customer (lastSeenAt + auto-advance stage NEW → CONTACTED)
  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      lastSeenAt: msg.timestamp,
      ...(customer.stage === 'NEW' ? { stage: 'CONTACTED' } : {}),
    },
  });

  // 7. Auto-route: if conversation has no assignee, run the routing engine
  if (!conversation.assigneeId) {
    // Extract first message text for keyword matching
    const firstMessageText =
      msg.content.kind === 'text' ? msg.content.text : null;

    await routeConversation({
      tenantId: channel.tenantId,
      conversationId: conversation.id,
      channelId: channel.id,
      channelType: channel.type,
      customerId: customer.id,
      customerTags: customer.tags,
      customerSource: customer.source,
      customerLanguage: null,
      firstMessageText,
    });
  }

  // 8. Stop any active follow-up sequences for this customer (they replied)
  await stopEnrollment(channel.tenantId, customer.id);

  logger.info(
    {
      customerId: customer.id,
      conversationId: conversation.id,
      type: msg.type,
    },
    'Inbound message processed',
  );
}

/**
 * Process a status update (delivered / read / failed) for an outbound message.
 */
export async function processStatusUpdate(status: ParsedStatusUpdate): Promise<void> {
  // Find the outbound message by its external message ID
  // We store the external ID in rawPayload when sending outbound messages
  // For now, just log — full status tracking requires storing wamid on outbound
  logger.info(
    { externalMessageId: status.externalMessageId, status: status.status },
    'Status update received',
  );
}

/**
 * Process all messages and statuses from a webhook result.
 */
export async function processWebhookResult(result: {
  messages: ParsedInboundMessage[];
  statuses: ParsedStatusUpdate[];
}): Promise<void> {
  for (const msg of result.messages) {
    try {
      await processInboundMessage(msg);
    } catch (err) {
      logger.error({ err, externalMessageId: msg.externalMessageId }, 'Failed to process inbound message');
    }
  }

  for (const status of result.statuses) {
    try {
      await processStatusUpdate(status);
    } catch (err) {
      logger.error({ err, externalMessageId: status.externalMessageId }, 'Failed to process status update');
    }
  }
}
