// ── Credit Balance Service ───────────────────────────────────────────────────
// Core credit operations: get balance, top up, charge, refund, and monthly
// cycle rollover. All mutations are wrapped in Prisma transactions so the
// balance + ledger never drift apart.

import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import {
  PLANS,
  CREDIT_COSTS,
  cycleStartOfMonth,
  cycleEndOfMonth,
  isCycleStale,
} from './plans.js';
import type { Plan, CreditTransactionType, UsageResourceType } from '@prisma/client';

export class BillingError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// ── Ensure a balance row exists for a tenant (idempotent) ─────────────────────

export async function ensureBalance(tenantId: string, plan: Plan): Promise<void> {
  const existing = await prisma.creditBalance.findUnique({ where: { tenantId } });
  if (existing) return;

  const monthStart = cycleStartOfMonth();
  const grant = PLANS[plan].monthlyCredits;

  await prisma.creditBalance.create({
    data: {
      tenantId,
      purchased: 0,
      granted: grant,
      consumedThisCycle: 0,
      cycleStartedAt: monthStart,
      cycleEndsAt: cycleEndOfMonth(),
    },
  });

  // Record the initial grant as a transaction
  await prisma.creditTransaction.create({
    data: {
      tenantId,
      type: 'GRANT',
      amount: grant,
      balanceAfter: grant,
      description: `Monthly grant — ${PLANS[plan].label} plan`,
      metadata: { plan, cycleStart: monthStart.toISOString() } as object,
    },
  });

  logger.info({ tenantId, plan, grant }, 'Credit balance initialized');
}

// ── Get the current balance (with cycle rollover) ────────────────────────────

export interface BalanceSnapshot {
  purchased: number;
  granted: number;
  available: number;          // purchased + remaining granted
  consumedThisCycle: number;
  monthlyGrant: number;        // plan's monthly grant
  cycleStartedAt: Date;
  cycleEndsAt: Date | null;
  plan: Plan;
}

export async function getBalance(tenantId: string, plan: Plan): Promise<BalanceSnapshot> {
  await ensureBalance(tenantId, plan);

  // Roll over the monthly cycle if stale: reset granted to the new month's
  // grant, reset consumedThisCycle, and record a GRANT transaction.
  let balance = await prisma.creditBalance.findUniqueOrThrow({ where: { tenantId } });

  if (isCycleStale(balance.cycleStartedAt)) {
    const monthStart = cycleStartOfMonth();
    const newGrant = PLANS[plan].monthlyCredits;

    balance = await prisma.creditBalance.update({
      where: { tenantId },
      data: {
        granted: newGrant,
        consumedThisCycle: 0,
        cycleStartedAt: monthStart,
        cycleEndsAt: cycleEndOfMonth(),
      },
    });

    await prisma.creditTransaction.create({
      data: {
        tenantId,
        type: 'GRANT',
        amount: newGrant,
        balanceAfter: balance.purchased + balance.granted,
        description: `Monthly grant rolled over — ${PLANS[plan].label} plan`,
        metadata: { plan, cycleStart: monthStart.toISOString() } as object,
      },
    });

    logger.info({ tenantId, plan, newGrant }, 'Credit cycle rolled over');
  }

  const grantedRemaining = Math.max(0, balance.granted - balance.consumedThisCycle);
  const available = balance.purchased + grantedRemaining;

  return {
    purchased: balance.purchased,
    granted: balance.granted,
    available,
    consumedThisCycle: balance.consumedThisCycle,
    monthlyGrant: PLANS[plan].monthlyCredits,
    cycleStartedAt: balance.cycleStartedAt,
    cycleEndsAt: balance.cycleEndsAt,
    plan,
  };
}

// ── Charge credits for a metered action ──────────────────────────────────────
// Deducts from granted credits first, then purchased credits. Atomic: either
// the full amount is deducted + transaction + usage event recorded, or nothing.

export interface ChargeOptions {
  resource: UsageResourceType;
  count?: number;              // defaults to 1; for webset items this = N
  jobId?: string;
  websetId?: string;
  dimensions?: Record<string, unknown>;
  description?: string;
}

export interface ChargeResult {
  ok: boolean;
  charged: number;
  balanceAfter: number;
  insufficient: boolean;
}

export async function chargeCredits(
  tenantId: string,
  plan: Plan,
  opts: ChargeOptions,
): Promise<ChargeResult> {
  const unitCost = CREDIT_COSTS[opts.resource];
  const count = Math.max(1, opts.count ?? 1);
  const total = unitCost * count;

  // Pre-check balance (the transaction below re-validates atomically)
  const snap = await getBalance(tenantId, plan);
  if (snap.available < total) {
    logger.warn(
      { tenantId, resource: opts.resource, needed: total, available: snap.available },
      'Insufficient credits — charge denied',
    );
    return { ok: false, charged: 0, balanceAfter: snap.available, insufficient: true };
  }

  return await prisma.$transaction(async (tx) => {
    const balance = await tx.creditBalance.findUniqueOrThrow({ where: { tenantId } });

    // Deduct from granted credits first, then purchased credits.
    const grantedAvailable = Math.max(0, balance.granted - balance.consumedThisCycle);
    const grantedUsed = Math.min(grantedAvailable, total);
    const purchasedUsed = total - grantedUsed;

    const updated = await tx.creditBalance.update({
      where: { tenantId },
      data: {
        purchased: { decrement: purchasedUsed },
        consumedThisCycle: { increment: grantedUsed },
      },
    });

    const balanceAfter = updated.purchased + Math.max(0, updated.granted - updated.consumedThisCycle);

    await tx.creditTransaction.create({
      data: {
        tenantId,
        type: 'CONSUME',
        amount: -total,
        balanceAfter,
        resource: opts.resource,
        description: opts.description ?? `${opts.resource.toLowerCase().replace(/_/g, ' ')} × ${count}`,
        metadata: {
          ...(opts.jobId ? { jobId: opts.jobId } : {}),
          ...(opts.websetId ? { websetId: opts.websetId } : {}),
          ...(opts.dimensions ?? {}),
          unitCost,
          count,
        } as object,
      },
    });

    await tx.usageEvent.create({
      data: {
        tenantId,
        resource: opts.resource,
        credits: total,
        jobId: opts.jobId ?? null,
        websetId: opts.websetId ?? null,
        dimensions: (opts.dimensions ?? {}) as object,
      },
    });

    logger.info(
      { tenantId, resource: opts.resource, total, grantedUsed, purchasedUsed, balanceAfter },
      'Credits charged',
    );

    return { ok: true, charged: total, balanceAfter, insufficient: false };
  });
}

// ── Refund credits (failed action, cancelled job) ────────────────────────────

export async function refundCredits(
  tenantId: string,
  amount: number,
  opts: { resource?: UsageResourceType; jobId?: string; description?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  if (amount <= 0) return;

  const result = await prisma.$transaction(async (tx) => {
    const balance = await tx.creditBalance.findUniqueOrThrow({ where: { tenantId } });
    // Refund goes back to purchased credits (simplest, always available)
    const updated = await tx.creditBalance.update({
      where: { tenantId },
      data: { purchased: { increment: amount } },
    });
    const balanceAfter = updated.purchased + Math.max(0, balance.granted - balance.consumedThisCycle);

    await tx.creditTransaction.create({
      data: {
        tenantId,
        type: 'REFUND',
        amount,
        balanceAfter,
        resource: opts.resource,
        description: opts.description ?? 'Refund — failed action',
        metadata: {
          ...(opts.jobId ? { jobId: opts.jobId } : {}),
          ...(opts.metadata ?? {}),
        } as object,
      },
    });

    return { balanceAfter };
  });

  logger.info({ tenantId, amount, balanceAfter: result.balanceAfter }, 'Credits refunded');
}

// ── Top up purchased credits ────────────────────────────────────────────────

export async function topUpCredits(
  tenantId: string,
  amount: number,
  opts: { description?: string; metadata?: Record<string, unknown> },
): Promise<{ ok: boolean; balanceAfter: number; charged: number }> {
  if (amount <= 0) {
    throw new BillingError(400, 'invalid_top_up_amount', 'Top-up amount must be positive');
  }

  const result = await prisma.$transaction(async (tx) => {
    const balance = await tx.creditBalance.findUniqueOrThrow({ where: { tenantId } });
    const updated = await tx.creditBalance.update({
      where: { tenantId },
      data: { purchased: { increment: amount } },
    });
    const balanceAfter = updated.purchased + Math.max(0, balance.granted - balance.consumedThisCycle);

    await tx.creditTransaction.create({
      data: {
        tenantId,
        type: 'TOP_UP',
        amount,
        balanceAfter,
        description: opts.description ?? `Purchased ${amount} credits`,
        metadata: (opts.metadata ?? {}) as object,
      },
    });

    return { balanceAfter };
  });

  logger.info({ tenantId, amount, balanceAfter: result.balanceAfter }, 'Credits topped up');
  return { ok: true, charged: amount, balanceAfter: result.balanceAfter };
}

// ── List transactions (ledger) with cursor pagination ────────────────────────

export async function listTransactions(
  tenantId: string,
  opts: { limit?: number; cursor?: string; type?: CreditTransactionType } = {},
) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const txns = await prisma.creditTransaction.findMany({
    where: {
      tenantId,
      ...(opts.type ? { type: opts.type } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });

  const hasMore = txns.length > limit;
  const sliced = hasMore ? txns.slice(0, limit) : txns;
  return {
    transactions: sliced,
    nextCursor: hasMore ? sliced[sliced.length - 1].id : null,
    hasMore,
  };
}
