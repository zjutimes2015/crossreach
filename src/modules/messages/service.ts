import { prisma } from '../../db/prisma.js';
import { sendWhatsAppMessage } from '../../channels/whatsapp/api.js';
import type { WhatsAppChannelConfig, MessageContent } from '../../channels/types.js';
import { logger } from '../../utils/logger.js';
import type { MessageType } from '@prisma/client';

const contentKindToMessageType: Record<string, MessageType> = {
  text: 'TEXT',
  image: 'IMAGE',
  audio: 'AUDIO',
  video: 'VIDEO',
  document: 'DOCUMENT',
  location: 'LOCATION',
  template: 'TEMPLATE',
  interactive: 'INTERACTIVE',
  button_reply: 'INTERACTIVE',
};

/**
 * Send an outbound message via the conversation's channel and persist it.
 */
export async function sendMessage(params: {
  tenantId: string;
  conversationId: string;
  content: MessageContent;
}): Promise<{ success: boolean; messageId?: string; externalMessageId?: string }> {
  // 1. Load conversation with channel + customer
  const conversation = await prisma.conversation.findFirst({
    where: { id: params.conversationId, tenantId: params.tenantId },
    include: { channel: true, customer: true },
  });

  if (!conversation) {
    logger.warn({ conversationId: params.conversationId }, 'Conversation not found for send');
    return { success: false };
  }

  const channelConfig = conversation.channel.config as unknown as WhatsAppChannelConfig;

  // 2. Send via WhatsApp Cloud API
  const result = await sendWhatsAppMessage(channelConfig, {
    to: conversation.customer.externalId,
    content: params.content,
  });

  if (result.status !== 'sent') {
    logger.error({ conversationId: params.conversationId }, 'WhatsApp API send failed');
    return { success: false };
  }

  // 3. Persist outbound message
  const message = await prisma.message.create({
    data: {
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      customerId: conversation.customerId,
      direction: 'OUTBOUND',
      type: contentKindToMessageType[params.content.kind] ?? 'TEXT',
      content: params.content as object,
      rawPayload: { externalMessageId: result.externalMessageId },
      status: 'SENT',
    },
  });

  // 4. Update conversation lastMessageAt
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { lastMessageAt: new Date() },
  });

  return {
    success: true,
    messageId: message.id,
    externalMessageId: result.externalMessageId,
  };
}

/**
 * List messages in a conversation (oldest first).
 */
export async function getMessages(
  tenantId: string,
  conversationId: string,
  options?: { limit?: number; offset?: number },
) {
  return prisma.message.findMany({
    where: { tenantId, conversationId },
    orderBy: { createdAt: 'asc' },
    take: options?.limit ?? 100,
    skip: options?.offset ?? 0,
  });
}
