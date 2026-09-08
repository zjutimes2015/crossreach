// ── Email deliverability: daily quotas, send pacing, account health ─────────
// Hard guards that keep a connected inbox out of the spam box / freeze:
//   • daily cap          — a per-account `dailyLimit` (config override, default)
//   • send pacing        — enforce a floor between sends (default 45s)
//   • health gating      — pause sending when bounce / complaint rates breach
//                          thresholds; resume automatically after a cooldown.
//
// The mailbox-facing counters are the EmailEvent rows we already record for
// every send, so quota and health read straight from the ledger with no extra
// keeper — no Redis, no separate counters.

import { prisma } from '../db/prisma.js';
import { recordEmailEvent } from './tracking.js';
import type { ConnectAccount, EmailEventType } from '@prisma/client';
import { logger } from '../utils/logger.js';

export class DeliverabilityError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    /** When true the caller may retry later instead of failing permanently. */
    public retryable: boolean,
  ) {
    super(message);
  }
}

// ── Tunables ────────────────────────────────────────────────────────────────
export const DEFAULT_DAILY_LIMIT = 60;        // safe default for a fresh inbox
export const DEFAULT_PACING_SECONDS = 45;     // floor between sequential sends
export const HEALTH_WINDOW_DAYS = 7;          // how far back to measure rates
export const MAX_BOUNCE_RATE = 0.05;          // >5% hard bounce → pause
export const MAX_COMPLAINT_RATE = 0.001;      // >0.1% spam complaints → pause
export const HEALTH_PAUSE_MINUTES = 60;       // auto-resume after this

// ── Pure helpers (unit-testable) ───────────────────────────────────────────

/** Start of the current UTC day. */
export function dailyWindowStart(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Start of the rolling health window (today − N days). */
export function healthWindowStart(days = HEALTH_WINDOW_DAYS, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** Bounce rate limited to [0,1]; 0 when nothing was sent. */
export function bounceRate(sent: number, hardBounces: number): number {
  if (sent <= 0) return 0;
  return Math.min(1, hardBounces / sent);
}

export type HealthStatus =
  | { ok: true }
  | { ok: false; reason: 'bounce_rate' | 'complaint_rate' };

/** Decide whether an account's recent track record is healthy enough to send. */
export function assessHealth(sent: number, hardBounces: number, complaints: number): HealthStatus {
  if (sent <= 0) return { ok: true };
  if (bounceRate(sent, hardBounces) > MAX_BOUNCE_RATE) return { ok: false, reason: 'bounce_rate' };
  if (complaints / sent > MAX_COMPLAINT_RATE) return { ok: false, reason: 'complaint_rate' };
  return { ok: true };
}

/** Parse the per-account daily cap, honoring a config override. */
export function dailyLimitOf(account: ConnectAccount): number {
  const cfg = (account.config as Record<string, unknown>) ?? {};
  const raw = cfg.dailyLimit;
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : DEFAULT_DAILY_LIMIT;
}

// ── Warm-up pool selection ──────────────────────────────────────────────────
// EMAIL dispatch picks ONE inbox from the tenant's pool on each send. To keep
// inboxes warm evenly (and out of the spam box) we prefer the account with the
// lowest today-sent count among those that still have quota headroom. Paused or
// saturated inboxes are skipped, then skipped-and-sorted by remaining budget.

/**
 * Pure round-robin-preference selector: from a list of inbox load rows pick the
 * id with the fewest sent today among those under their daily cap. Returns null
 * when every inbox is at/over its cap (or the list is empty — caller decides).
 */
export function chooseAccountByLoad(
  rows: Array<{ id: string; sent: number; dailyLimit: number }>,
): string | null {
  const candidates = rows.filter((r) => r.sent < r.dailyLimit);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.sent - b.sent);
  return candidates[0].id;
}

/**
 * Choose the next EMAIL inbox for a tenant's warm-up pool, skipping any that is
 * paused for health or has hit its daily cap. Throws a DeliverabilityError when
 * no inbox is connected or none currently has quota headroom.
 */
export async function pickEmailAccount(
  tenantId: string,
  now: Date = new Date(),
): Promise<ConnectAccount> {
  const accounts = await prisma.connectAccount.findMany({
    where: { tenantId, channel: 'EMAIL', status: 'ACTIVE' },
  });
  if (accounts.length === 0) {
    throw new DeliverabilityError(
      400,
      'no_email_account_connected',
      'No email inbox is connected. Add one under Connect, then retry.',
      false,
    );
  }

  const nowMs = now.getTime();
  const notPaused = accounts.filter((a) => {
    const cfg = (a.config as Record<string, unknown>) ?? {};
    const until = typeof cfg.pausedUntil === 'string' ? Date.parse(cfg.pausedUntil) : NaN;
    return !(Number.isFinite(until) && until > nowMs);
  });
  if (notPaused.length === 0) {
    throw new DeliverabilityError(
      429,
      'all_email_accounts_health_paused',
      'Every connected inbox is cooling down after a health breach. Try again later.',
      true,
    );
  }

  const loads = await Promise.all(
    notPaused.map(async (a) => ({ id: a.id, sent: await countSentToday(a.id, now), dailyLimit: dailyLimitOf(a) })),
  );
  const pick = chooseAccountByLoad(loads);
  if (!pick) {
    throw new DeliverabilityError(
      429,
      'all_email_accounts_at_limit',
      'Every connected inbox has reached its daily send limit. Try again tomorrow.',
      true,
    );
  }
  return accounts.find((a) => a.id === pick)!;
}

// ── Store-backed assessments ───────────────────────────────────────────────

/** How many tracked SENT events this account fired since the UTC day boundary. */
export async function countSentToday(accountId: string, now: Date = new Date()): Promise<number> {
  return prisma.emailEvent.count({
    where: {
      accountId,
      type: 'SENT',
      createdAt: { gte: dailyWindowStart(now) },
    },
  });
}

/** Rolling delivery stats for the health window. */
export async function accountStats(accountId: string, now: Date = new Date()) {
  const since = healthWindowStart(HEALTH_WINDOW_DAYS, now);
  const grouped = await prisma.emailEvent.groupBy({
    by: ['type'],
    where: { accountId, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const byType = new Map<string, number>(
    grouped.map((g) => [g.type, g._count._all]),
  );
  const sent = byType.get('SENT') ?? 0;
  return {
    sent,
    hardBounces: byType.get('BOUNCED_HARD') ?? 0,
    softBounces: byType.get('BOUNCED_SOFT') ?? 0,
    complaints: byType.get('COMPLAINED') ?? 0,
    opens: byType.get('OPENED') ?? 0,
    clicks: byType.get('CLICKED') ?? 0,
    at: now,
    since,
  };
}

/**
 * The full send gate. Throws a DeliverabilityError with a machine-readable
 * `code` so the dispatch layer can fail the job correctly. Checks, in order:
 * temporary health pause → daily cap → send pacing.
 */
export async function assertCanSend(
  account: ConnectAccount,
  now: Date = new Date(),
): Promise<void> {
  const cfg = (account.config as Record<string, unknown>) ?? {};

  // 1. Cooldown pause set after a health breach.
  const pausedUntil = typeof cfg.pausedUntil === 'string' ? Date.parse(cfg.pausedUntil) : NaN;
  if (Number.isFinite(pausedUntil) && pausedUntil > now.getTime()) {
    const ms = pausedUntil - now.getTime();
    throw new DeliverabilityError(
      429,
      'email_account_health_paused',
      `Email account health is cooling down — resumed in ${Math.ceil(ms / 60_000)} min`,
      true,
    );
  }

  // 2. Daily cap.
  const sentToday = await countSentToday(account.id, now);
  const limit = dailyLimitOf(account);
  if (sentToday >= limit) {
    throw new DeliverabilityError(
      429,
      'email_daily_limit_reached',
      `Daily send limit of ${limit} reached for this inbox (${sentToday} sent today). Try again tomorrow.`,
      true,
    );
  }

  // 3. Pacing — no two sends within `minIntervalSeconds` of each other.
  const pacing = cfg.minIntervalSeconds;
  const interval = typeof pacing === 'number' && pacing > 0 ? pacing : DEFAULT_PACING_SECONDS;
  const last = await prisma.emailEvent.findFirst({
    where: { accountId: account.id, type: 'SENT' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (last && now.getTime() - last.createdAt.getTime() < interval * 1000) {
    throw new DeliverabilityError(
      429,
      'email_pacing_throttled',
      `Inbox is throttled — send another message in ${interval}s.`,
      true,
    );
  }
}

/**
 * Apply inbound bounce / complaint feedback to an account: record the event and,
 * if the rolling health now breaches a threshold, put the account into a
 * cooldown pause so subsequent sends are rejected by `assertCanSend`.
 */
export async function applyBounceFeedback(
  account: ConnectAccount,
  feedback: {
    type: EmailEventType;
    recipient?: string;
    messageId?: string;
    smtpCode?: number;
    detail?: string;
  },
  now: Date = new Date(),
): Promise<{ paused: boolean; reason?: 'bounce_rate' | 'complaint_rate' }> {
  // Persist the event first.
  await recordEmailEvent({
    type: feedback.type,
    accountId: account.id,
    recipient: feedback.recipient,
    messageId: feedback.messageId,
    smtpCode: feedback.smtpCode,
    detail: feedback.detail,
  });

  const stats = await accountStats(account.id, now);
  const health = assessHealth(stats.sent, stats.hardBounces, stats.complaints);
  if (health.ok) return { paused: false };

  const pausedUntil = new Date(now.getTime() + HEALTH_PAUSE_MINUTES * 60_000);
  const newConfig = {
    ...((account.config as Record<string, unknown>) ?? {}),
    pausedUntil: pausedUntil.toISOString(),
    pauseReason: health.reason === 'bounce_rate' ? 'bounce_rate' : 'complaint_rate',
  };
  await prisma.connectAccount.update({
    where: { id: account.id },
    data: { config: newConfig as object },
  });

  logger.warn(
    {
      accountId: account.id,
      tenantId: account.tenantId,
      reason: health.reason,
      sent: stats.sent,
      bounces: stats.hardBounces,
      complaints: stats.complaints,
    },
    'Email account paused for health',
  );
  return { paused: true, reason: health.reason };
}