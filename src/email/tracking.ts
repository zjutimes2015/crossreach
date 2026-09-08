// ── Email tracking: token lifecycle + HTML instrumentation + event log ──────
// A single opaque token per send drives four things:
//   1. the open pixel       /{base}/_track/:token/open.gif
//   2. click-through links  /{base}/_track/:token/click?url=<enc>
//   3. unsubscribes         /{base}/_track/:token/unsubscribe
//   4. the X-CrossReach-Token SMTP header, echoed back by bounce webhooks so
//      we can attribute a hard bounce / complaint to the exact send + account.
//
// The URL builders are pure (no prisma/config imports) so they're unit-testable
// in isolation; the recorders that write to the store stay separate.

import { randomBytes } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import type { EmailEventType } from '@prisma/client';

export const TRACK_HEADER = 'x-crossreach-token';
export const TRANS_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', // 1×1 transparent GIF
  'base64',
);

/** Ceryptographically-random opaque token (32 bytes → 43 URL-safe chars). */
export function generateTrackingToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Public URL paths for a given token. `baseUrl` is injected by the caller. */
export function trackUrls(baseUrl: string, token: string) {
  return {
    open: `${baseUrl}/_track/${token}/open.gif`,
    click: `${baseUrl}/_track/${token}/click`,
    unsubscribe: `${baseUrl}/_track/${token}/unsubscribe`,
  } as const;
}

/**
 * Instrument an HTML body: wrap absolute http(s) links through the click
 * redirector and append the invisible open pixel. Links that already point at
 * our own tracking host are left untouched. Returns the ORIGINAL body unchanged
 * if it's not HTML.
 */
export function injectTracking(html: string, baseUrl: string, token: string): string {
  const { click, open } = trackUrls(baseUrl, token);
  // Wrap http(s) links in our redirect so we can record click-throughs.
  const wrapped = html.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (match, target: string) => `href="${click}?url=${encodeURIComponent(target)}"`,
  );
  const pixel = `<img src="${open}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;"/>`;
  if (/<\/body>/i.test(wrapped)) return wrapped.replace(/<\/body>/i, `${pixel}</body>`);
  return `${wrapped}${pixel}`;
}

// ── Store writes ───────────────────────────────────────────────────────────

export interface CreateTokenInput {
  tenantId: string;
  accountId?: string;
  jobId?: string;
  customerId?: string;
  recipient: string;
  messageId?: string;
  expiresInSec?: number;
}

export async function createTrackingToken(input: CreateTokenInput): Promise<string> {
  const token = generateTrackingToken();
  await prisma.emailTrackingToken.create({
    data: {
      token,
      tenantId: input.tenantId,
      accountId: input.accountId ?? null,
      jobId: input.jobId ?? null,
      customerId: input.customerId ?? null,
      recipient: input.recipient,
      messageId: input.messageId ?? null,
      expiresAt: input.expiresInSec
        ? new Date(Date.now() + input.expiresInSec * 1000)
        : null,
    },
  });
  return token;
}

export interface RecordEventInput {
  token?: string;
  type: EmailEventType;
  recipient?: string;
  accountId?: string;
  messageId?: string;
  smtpCode?: number;
  detail?: string;
}

/**
 * Idempotently record one delivery event. `EmailEvent` has a partial unique on
 * `[trackToken, type]`, so repeated opens/clicks/complaints collapse into a
 * single row per token — enough for stats, no spam in the ledger. Untracked
 * events (e.g. a bounce not attributable to a header) fall back to a fire-once
 * row keyed by nothing, so we still keep history without duplicates.
 */
export async function recordEmailEvent(input: RecordEventInput): Promise<void> {
  const tenantId = await resolveTenantForEvent(input);
  const where = input.token
    ? { trackToken_type: { trackToken: input.token, type: input.type } }
    : undefined;

  const payload = {
    tenantId,
    accountId: input.accountId ?? null,
    trackToken: input.token ?? null,
    type: input.type,
    recipient: input.recipient ?? null,
    messageId: input.messageId ?? null,
    smtpCode: input.smtpCode ?? null,
    detail: input.detail ?? null,
  };

  if (where) {
    await prisma.emailEvent.upsert({ where, create: payload, update: {} });
  } else {
    await prisma.emailEvent.create({ data: payload });
  }
}

async function resolveTenantForEvent(input: RecordEventInput): Promise<string> {
  if (input.token) {
    const t = await prisma.emailTrackingToken.findUnique({
      where: { token: input.token },
      select: { tenantId: true },
    });
    if (t) return t.tenantId;
  }
  if (input.accountId) {
    const a = await prisma.connectAccount.findFirst({
      where: { id: input.accountId },
      select: { tenantId: true },
    });
    if (a) return a.tenantId;
  }
  // Bounce webhooks carry no tenant info; if nothing resolved, callers must
  // look the token up first. Fall back to a sentinel so writes never crash.
  return 'unknown';
}