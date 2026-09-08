// ── Usage Metering Service ───────────────────────────────────────────────────
// Aggregates usage events for dashboards and billing queries. Supports
// per-resource breakdowns and time-windowed summaries.

import { prisma } from '../../db/prisma.js';
import type { UsageResourceType } from '@prisma/client';

export interface UsageSummary {
  totalCredits: number;
  totalEvents: number;
  byResource: Array<{
    resource: UsageResourceType;
    credits: number;
    events: number;
  }>;
}

const RESOURCE_ORDER: UsageResourceType[] = [
  'WEBSET_ITEM',
  'OUTREACH_SEND',
  'RESEARCH',
  'CONTACT_FIND',
  'AI_GENERATE',
];

/** Aggregate usage for a tenant within an optional [from, to] window. */
export async function getUsageSummary(
  tenantId: string,
  opts: { from?: Date; to?: Date } = {},
): Promise<UsageSummary> {
  const where = {
    tenantId,
    ...(opts.from || opts.to
      ? {
          createdAt: {
            ...(opts.from ? { gte: opts.from } : {}),
            ...(opts.to ? { lt: opts.to } : {}),
          },
        }
      : {}),
  };

  const grouped = await prisma.usageEvent.groupBy({
    by: ['resource'],
    where,
    _sum: { credits: true },
    _count: { _all: true },
  });

  const map = new Map<string, { credits: number; events: number }>();
  for (const g of grouped) {
    map.set(g.resource, {
      credits: g._sum.credits ?? 0,
      events: g._count._all ?? 0,
    });
  }

  let totalCredits = 0;
  let totalEvents = 0;
  const byResource = RESOURCE_ORDER.map((resource) => {
    const entry = map.get(resource) ?? { credits: 0, events: 0 };
    totalCredits += entry.credits;
    totalEvents += entry.events;
    return { resource, credits: entry.credits, events: entry.events };
  }).filter((r) => r.events > 0);

  return { totalCredits, totalEvents, byResource };
}

/** List raw usage events with cursor pagination (newest first). */
export async function listUsageEvents(
  tenantId: string,
  opts: { limit?: number; cursor?: string; resource?: UsageResourceType } = {},
) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const events = await prisma.usageEvent.findMany({
    where: {
      tenantId,
      ...(opts.resource ? { resource: opts.resource } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });

  const hasMore = events.length > limit;
  const sliced = hasMore ? events.slice(0, limit) : events;
  return {
    events: sliced,
    nextCursor: hasMore ? sliced[sliced.length - 1].id : null,
    hasMore,
  };
}
