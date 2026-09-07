import { prisma } from '../../db/prisma.js';
import type { Customer } from '@prisma/client';

// ── Find or create a customer by external ID (e.g. WhatsApp phone number) ──

export async function findOrCreateCustomer(params: {
  tenantId: string;
  externalId: string;
  name?: string;
  email?: string;
  phone?: string;
  source?: string;
}): Promise<Customer> {
  const existing = await prisma.customer.findUnique({
    where: {
      tenantId_externalId: {
        tenantId: params.tenantId,
        externalId: params.externalId,
      },
    },
  });

  if (existing) {
    // Backfill name/email if we now have them and the record doesn't
    const updateData: Record<string, string> = {};
    if (params.name && !existing.name) updateData.name = params.name;
    if (params.email && !existing.email) updateData.email = params.email;
    if (Object.keys(updateData).length > 0) {
      return prisma.customer.update({
        where: { id: existing.id },
        data: updateData,
      });
    }
    return existing;
  }

  return prisma.customer.create({
    data: {
      tenantId: params.tenantId,
      externalId: params.externalId,
      name: params.name,
      email: params.email,
      phone: params.phone ?? params.externalId,
      source: params.source,
      stage: 'NEW',
    },
  });
}

// ── Query / mutate ─────────────────────────────────────────────────────────

export async function getCustomers(
  tenantId: string,
  options?: { stage?: string; limit?: number; offset?: number },
) {
  return prisma.customer.findMany({
    where: {
      tenantId,
      ...(options?.stage ? { stage: options.stage as Customer['stage'] } : {}),
    },
    orderBy: { lastSeenAt: 'desc' },
    take: options?.limit ?? 50,
    skip: options?.offset ?? 0,
  });
}

export async function getCustomerById(tenantId: string, customerId: string) {
  return prisma.customer.findFirst({
    where: { id: customerId, tenantId },
    include: {
      conversations: {
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { channel: true },
      },
    },
  });
}

export async function updateCustomerStage(
  tenantId: string,
  customerId: string,
  stage: Customer['stage'],
) {
  return prisma.customer.update({
    where: { id: customerId },
    data: { stage },
  });
}

export async function addTag(tenantId: string, customerId: string, tag: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, tenantId },
  });
  if (!customer) return null;

  const tags = [...new Set([...customer.tags, tag])];
  return prisma.customer.update({
    where: { id: customerId },
    data: { tags },
  });
}
