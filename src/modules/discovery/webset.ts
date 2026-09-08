// ── Webset Service (对标 Revor revor_create_webset / get_webset / list_webset_items) ─
// A "webset" = a prospect list built from a natural-language ICP. Creating it
// returns immediately with a webset ID + a preparation job ID (HTTP 202-style);
// the actual discovery runs asynchronously. Clients poll the job, then page
// through ranked results once preparation reports progress.

import { prisma } from '../../db/prisma.js';
import { Prisma } from '@prisma/client';
import { logger } from '../../utils/logger.js';
import { stubProvider } from './provider.js';
import type { IcpCriteria } from './provider.js';
import type { Webset, WebsetTargetKind, DiscoveryJobStatus } from '@prisma/client';
import { getBalance, chargeCredits, refundCredits } from '../billing/balance.js';

export class WebsetError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

// Tier-bounded result counts (Revor: never silently reduce an out-of-tier request)
const TIER_COUNTS: Record<string, number[]> = {
  FREE: [25],
  STARTER: [25, 100],
  GROWTH: [25, 100, 500],
  PRO: [25, 100, 500, 1000],
  ENTERPRISE: [25, 100, 500, 1000],
};

function tierForPlan(plan: string): string {
  if (plan === 'PRO' || plan === 'ENTERPRISE') return plan;
  if (plan === 'GROWTH') return 'GROWTH';
  return 'STARTER';
}

// ── Create a webset (starts async preparation) ──────────────────────────────

export interface CreateWebsetRequest {
  name?: string;
  targetKind: WebsetTargetKind;
  criteria: IcpCriteria;
  idempotencyKey?: string;
}

export interface CreateWebsetResponse {
  ok: boolean;
  item: {
    id: string;
    name: string;
    targetKind: WebsetTargetKind;
    status: string;
    requestedCount: number;
    preparationJobId: string;
  };
  nextAction: {
    retryAfterMs: number;
    arguments: { job_id: string };
  } | null;
}

export async function createWebset(
  tenantId: string,
  tenantPlan: string,
  req: CreateWebsetRequest,
): Promise<CreateWebsetResponse> {
  const criteria = req.criteria;
  if (!criteria?.prompt?.trim()) {
    throw new WebsetError(400, 'icp_prompt_required', 'criteria.prompt (natural-language ICP) is required');
  }

  // Validate requested count against the tenant tier
  const tier = tierForPlan(tenantPlan);
  const allowed = TIER_COUNTS[tier];
  const requested = criteria.count ?? 25;
  if (!allowed.includes(requested)) {
    throw new WebsetError(
      403,
      'membership_tier_count_not_allowed',
      `Your ${tier} tier allows counts of [${allowed.join(', ')}]; ${requested} is not available. Upgrade or pick an allowed count.`,
    );
  }

  // Idempotency: store the key in the job input for traceability. A real
  // implementation would dedup on a unique idempotencyKey column; we keep the
  // pipeline simple here and rely on the client to reuse keys for retries.
  const name = req.name?.trim() || truncate(criteria.prompt, 60);

  // ── Credit check: charge upfront for the requested prospect count ──────
  // Revor bills credits when a webset runs. We charge `requested` WEBSET_ITEM
  // credits here; if discovery yields fewer results or fails, the difference
  // is refunded inside runWebsetPreparation.
  const balance = await getBalance(tenantId, tenantPlan as 'STARTER' | 'GROWTH' | 'PRO' | 'ENTERPRISE');
  if (balance.available < requested) {
    throw new WebsetError(
      402,
      'insufficient_credits',
      `This webset needs ${requested} credits; balance is ${balance.available}. Top up at /api/v1/billing/top-up.`,
    );
  }
  const charge = await chargeCredits(tenantId, tenantPlan as 'STARTER' | 'GROWTH' | 'PRO' | 'ENTERPRISE', {
    resource: 'WEBSET_ITEM',
    count: requested,
    dimensions: { targetKind: req.targetKind, prompt: truncate(criteria.prompt, 40) },
    description: `Webset preparation — ${requested} prospects`,
  });
  if (!charge.ok) {
    throw new WebsetError(402, 'insufficient_credits', charge.insufficient ? 'Insufficient credits' : 'Credit charge failed');
  }
  const chargedCredits = charge.charged;

  // Create the preparation job first
  const job = await prisma.discoveryJob.create({
    data: {
      tenantId,
      kind: 'WEBSET_PREPARATION',
      status: 'QUEUED',
      input: { criteria, targetKind: req.targetKind, idempotencyKey: req.idempotencyKey ?? null, chargedCredits } as object,
      nextAction: { retry_after_ms: 3000, arguments: { job_id: '' } } as object,
    },
  });

  const webset = await prisma.webset.create({
    data: {
      tenantId,
      name,
      targetKind: req.targetKind,
      criteria: { ...criteria, count: requested } as object,
      status: 'PREPARING',
      requestedCount: requested,
      itemCount: 0,
      preparationJobId: job.id,
    },
  });

  // Patch nextAction.arguments.job_id now that we have the job id
  await prisma.discoveryJob.update({
    where: { id: job.id },
    data: { nextAction: { retry_after_ms: 3000, arguments: { job_id: job.id } } as object },
  });

  logger.info({ websetId: webset.id, jobId: job.id, targetKind: req.targetKind }, 'Webset created, preparation queued');

  // Execute asynchronously (don't block the response — Revor returns 202-style)
  setImmediate(() => {
    runWebsetPreparation(job.id, webset.id).catch((err) => {
      logger.error({ err, jobId: job.id }, 'Webset preparation failed');
    });
  });

  return toCreateResponse(webset, job.id, { retryAfterMs: 3000, arguments: { job_id: job.id } });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function toCreateResponse(
  ws: Webset,
  jobId: string,
  nextAction: { retryAfterMs: number; arguments: { job_id: string } } | null,
): CreateWebsetResponse {
  return {
    ok: true,
    item: {
      id: ws.id,
      name: ws.name,
      targetKind: ws.targetKind,
      status: ws.status,
      requestedCount: ws.requestedCount,
      preparationJobId: jobId,
    },
    nextAction,
  };
}

// ── Async webset preparation (runs in the background) ───────────────────────

async function runWebsetPreparation(jobId: string, websetId: string): Promise<void> {
  const job = await prisma.discoveryJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  const input = job.input as unknown as { criteria: IcpCriteria; targetKind: WebsetTargetKind; chargedCredits?: number };
  const chargedCredits = input.chargedCredits ?? 0;
  if (job.status === 'CANCELLED') {
    logger.info({ jobId }, 'Webset preparation cancelled before execution');
    return;
  }

  await prisma.discoveryJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  try {
    // Simulate latency for a long-running discovery (Revor websets are async)
    await new Promise((r) => setTimeout(r, 1500));

    const criteria = input.criteria;
    const isCompany = input.targetKind === 'COMPANY';
    const results = isCompany
      ? await stubProvider.discoverCompanies(criteria)
      : await stubProvider.discoverPeople(criteria);

    // Persist ranked items
    await prisma.websetItem.createMany({
      data: results.map((r, i) => ({
        websetId,
        tenantId: job.tenantId,
        rank: i + 1,
        data: r as object,
        matchScore: (r as { matchScore: number }).matchScore ?? null,
        isProvisional: false,
      })),
    });

    await prisma.webset.update({
      where: { id: websetId },
      data: { status: 'READY', itemCount: results.length },
    });

    await prisma.discoveryJob.update({
      where: { id: jobId },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        result: { websetId, itemCount: results.length, targetKind: input.targetKind } as object,
        billing: { chargedCredits: results.length } as object,
        nextAction: Prisma.DbNull,
      },
    });

    // Refund the difference if discovery yielded fewer results than charged
    if (chargedCredits > results.length) {
      const refund = chargedCredits - results.length;
      await refundCredits(job.tenantId, refund, {
        resource: 'WEBSET_ITEM',
        jobId,
        description: `Webset refund — ${refund} unused credits (got ${results.length}/${chargedCredits})`,
        metadata: { websetId, requested: chargedCredits, actual: results.length },
      });
    }

    logger.info({ jobId, websetId, itemCount: results.length }, 'Webset preparation succeeded');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'preparation failed';
    await prisma.webset.update({ where: { id: websetId }, data: { status: 'FAILED' } });
    await prisma.discoveryJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: { code: 'preparation_failed', message } as object,
        nextAction: Prisma.DbNull,
      },
    });
    // Refund the full upfront charge — discovery yielded nothing
    if (chargedCredits > 0) {
      await refundCredits(job.tenantId, chargedCredits, {
        resource: 'WEBSET_ITEM',
        jobId,
        description: `Webset refund — preparation failed (${chargedCredits} credits)`,
        metadata: { websetId, reason: 'preparation_failed' },
      });
    }
    logger.error({ err, jobId, websetId }, 'Webset preparation failed');
  }
}

// ── List websets (cursor pagination) ─────────────────────────────────────────

export async function listWebsets(
  tenantId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ websets: WebsetSummary[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const websets = await prisma.webset.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    select: { id: true, name: true, targetKind: true, status: true, itemCount: true, requestedCount: true, createdAt: true },
  });

  const hasMore = websets.length > limit;
  const sliced = hasMore ? websets.slice(0, limit) : websets;
  return {
    websets: sliced,
    nextCursor: hasMore ? sliced[sliced.length - 1].id : null,
    hasMore,
  };
}

type WebsetSummary = {
  id: string; name: string; targetKind: string; status: string;
  itemCount: number; requestedCount: number; createdAt: Date;
};

// ── Get a single webset (status + progress + criteria) ───────────────────────

export async function getWebset(tenantId: string, websetId: string) {
  const ws = await prisma.webset.findFirst({
    where: { id: websetId, tenantId },
    include: { preparationJob: { select: { id: true, status: true, finishedAt: true } } },
  });
  return ws;
}

// ── List webset items (cursor pagination + detail modes) ────────────────────
// Revor detail modes: compact (≤50/page), standard (≤25), full (≤10).

export type DetailMode = 'compact' | 'standard' | 'full';

const DETAIL_LIMITS: Record<DetailMode, number> = { compact: 50, standard: 25, full: 10 };

export async function listWebsetItems(
  tenantId: string,
  websetId: string,
  opts: { detail?: DetailMode; limit?: number; cursor?: string } = {},
) {
  const detail = opts.detail ?? 'compact';
  const limit = Math.min(opts.limit ?? DETAIL_LIMITS[detail], DETAIL_LIMITS[detail]);

  const ws = await prisma.webset.findFirst({
    where: { id: websetId, tenantId },
    select: { id: true, status: true, itemCount: true, requestedCount: true },
  });
  if (!ws) return null;

  // Offset pagination keyed on rank (stable ordering across polls)
  const afterRank = opts.cursor ? Number(opts.cursor) : 0;
  const items = await prisma.websetItem.findMany({
    where: { websetId, tenantId, rank: { gt: afterRank } },
    orderBy: { rank: 'asc' },
    take: limit + 1,
  });

  const hasMore = items.length > limit;
  const sliced = hasMore ? items.slice(0, limit) : items;

  const formatted = sliced.map((it) => projectDetail(it.data as Record<string, unknown>, detail, it));

  return {
    websetId: ws.id,
    status: ws.status,
    itemCount: ws.itemCount,
    requestedCount: ws.requestedCount,
    items: formatted,
    nextCursor: hasMore ? String(sliced[sliced.length - 1].rank) : null,
    hasMore,
    detail,
  };
}

function projectDetail(data: Record<string, unknown>, detail: DetailMode, row: { id: string; rank: number; matchScore: number | null; isProvisional: boolean }) {
  const base = { id: row.id, rank: row.rank, matchScore: row.matchScore, isProvisional: row.isProvisional };
  if (detail === 'compact') {
    // Core fields only
    return { ...base, name: data.name, domain: data.domain ?? data.companyDomain ?? null, ...(data.title ? { title: data.title } : {}), matchScore: row.matchScore };
  }
  if (detail === 'standard') {
    return { ...base, ...data };
  }
  // full: everything including criteria reasoning
  return { ...base, ...data, _criteriaReasoning: `Matches ICP on ${(data.signals as string[] | undefined ?? ['industry']).join(', ')}` };
}
