import { prisma } from '../../db/prisma.js';
import type { Conversation } from '@prisma/client';

// ── Find or create an open conversation for a customer + channel ───────────

export async function findOrCreateConversation(params: {
  tenantId: string;
  customerId: string;
  channelId: string;
}): Promise<Conversation> {
  const existing = await prisma.conversation.findFirst({
    where: {
      tenantId: params.tenantId,
      customerId: params.customerId,
      channelId: params.channelId,
      status: { in: ['OPEN', 'PENDING'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      tenantId: params.tenantId,
      customerId: params.customerId,
      channelId: params.channelId,
      status: 'OPEN',
    },
  });
}

// ── Query / mutate ─────────────────────────────────────────────────────────

export async function getConversations(
  tenantId: string,
  options?: {
    status?: string;
    assigneeId?: string;
    limit?: number;
    offset?: number;
  },
) {
  return prisma.conversation.findMany({
    where: {
      tenantId,
      ...(options?.status
        ? { status: options.status as Conversation['status'] }
        : {}),
      ...(options?.assigneeId ? { assigneeId: options.assigneeId } : {}),
    },
    include: {
      customer: true,
      channel: true,
      messages: { take: 1, orderBy: { createdAt: 'desc' } },
    },
    orderBy: { lastMessageAt: 'desc' },
    take: options?.limit ?? 50,
    skip: options?.offset ?? 0,
  });
}

export async function getConversationById(tenantId: string, conversationId: string) {
  return prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: {
      customer: true,
      channel: true,
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function assignConversation(
  tenantId: string,
  conversationId: string,
  assigneeId: string,
) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { assigneeId },
  });
}

export async function resolveConversation(tenantId: string, conversationId: string) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { status: 'RESOLVED' },
  });
}
