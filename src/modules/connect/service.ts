// ── Connect Accounts Service (对标 Revor "Connect" feature) ───────────────────
// Manage connected sending accounts — email inboxes, LinkedIn sessions, and
// WhatsApp Business numbers — that the outreach dispatch pipeline uses to
// send outbound messages. Mirrors Revor's "Connect" page: link once, then
// dispatch outreach tasks to the account.
//
// Plan enforcement: each tier limits how many email inboxes and social
// channels (LinkedIn + WhatsApp combined) a tenant can connect. STARTER has
// 1 inbox / 0 social; GROWTH 1 / 1; PRO 1 / 2; ENTERPRISE unlimited.

import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import { PLANS } from '../billing/plans.js';
import type {
  ConnectAccount,
  ConnectAccountStatus,
  ConnectChannelType,
  Plan,
} from '@prisma/client';

export class ConnectError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// ── Plan quotas (single source of truth: plans.ts) ─────────────────────────

export function planQuota(plan: Plan): { emailInboxes: number; socialChannels: number } {
  return {
    emailInboxes: PLANS[plan].emailInboxes,
    socialChannels: PLANS[plan].socialChannels,
  };
}

// ── Public response shape ──────────────────────────────────────────────────

export interface ConnectAccountResponse {
  id: string;
  channel: ConnectChannelType;
  name: string;
  status: ConnectAccountStatus;
  // Secrets masked by default; revealed only via the ?reveal=1 query or when
  // the caller is the tenant owner performing setup.
  config: Record<string, unknown>;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const SECRET_FIELDS: Record<ConnectChannelType, string[]> = {
  EMAIL: ['smtpPass'],
  WHATSAPP: ['accessToken'],
  LINKEDIN: ['sessionCookie'],
};

function maskSecrets(
  channel: ConnectChannelType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const masked = { ...config };
  for (const key of SECRET_FIELDS[channel] ?? []) {
    if (masked[key] !== undefined) masked[key] = '••••••••';
  }
  return masked;
}

function toResponse(
  acc: ConnectAccount,
  opts: { revealSecrets?: boolean } = {},
): ConnectAccountResponse {
  const config = (acc.config as Record<string, unknown>) ?? {};
  return {
    id: acc.id,
    channel: acc.channel,
    name: acc.name,
    status: acc.status,
    config: opts.revealSecrets ? config : maskSecrets(acc.channel, config),
    lastUsedAt: acc.lastUsedAt?.toISOString() ?? null,
    createdAt: acc.createdAt.toISOString(),
    updatedAt: acc.updatedAt.toISOString(),
  };
}

// ── Config validation (per channel) ────────────────────────────────────────

export function validateConfig(
  channel: ConnectChannelType,
  config: Record<string, unknown>,
): void {
  const need = (key: string, label: string) => {
    if (config[key] === undefined || config[key] === null || String(config[key]).trim() === '') {
      throw new ConnectError(400, `config_${key}_required`, `config.${label} is required for ${channel.toLowerCase()}`);
    }
  };
  switch (channel) {
    case 'EMAIL':
      need('smtpHost', 'smtpHost');
      need('smtpPort', 'smtpPort');
      need('smtpUser', 'smtpUser');
      need('smtpPass', 'smtpPass');
      need('fromAddress', 'fromAddress');
      break;
    case 'WHATSAPP':
      need('phoneNumberId', 'phoneNumberId');
      need('accessToken', 'accessToken');
      need('verifyToken', 'verifyToken');
      break;
    case 'LINKEDIN':
      need('sessionCookie', 'sessionCookie');
      break;
  }
}

// ── Quota enforcement ──────────────────────────────────────────────────────

async function enforceQuota(
  tenantId: string,
  plan: Plan,
  channel: ConnectChannelType,
): Promise<void> {
  const quota = planQuota(plan);
  const isEmail = channel === 'EMAIL';
  const limit = isEmail ? quota.emailInboxes : quota.socialChannels;
  if (limit === 0) {
    throw new ConnectError(
      403,
      'plan_quota_exceeded',
      `Your ${plan} plan does not include any ${isEmail ? 'email inbox' : 'social channel'} connections. Upgrade at /api/v1/billing/plan.`,
    );
  }
  const count = await prisma.connectAccount.count({
    where: isEmail
      ? { tenantId, channel: 'EMAIL' }
      : { tenantId, channel: { in: ['LINKEDIN', 'WHATSAPP'] } },
  });
  if (count >= limit) {
    throw new ConnectError(
      403,
      'plan_quota_exceeded',
      `Your ${plan} plan allows ${limit} ${isEmail ? 'email inbox' : 'social channel'}(s); you already have ${count} connected. Upgrade at /api/v1/billing/plan.`,
    );
  }
}

// ── Create a connect account ────────────────────────────────────────────────

export interface CreateConnectAccountRequest {
  channel: ConnectChannelType;
  name: string;
  config: Record<string, unknown>;
  status?: ConnectAccountStatus;
}

export async function createConnectAccount(
  tenantId: string,
  tenantPlan: Plan,
  req: CreateConnectAccountRequest,
): Promise<ConnectAccountResponse> {
  if (!req.channel) throw new ConnectError(400, 'channel_required', 'channel is required');
  if (!req.name?.trim()) throw new ConnectError(400, 'name_required', 'name is required');
  if (!req.config) throw new ConnectError(400, 'config_required', 'config is required');

  validateConfig(req.channel, req.config);
  await enforceQuota(tenantId, tenantPlan, req.channel);

  // Schema enforces @@unique([tenantId, channel]) — one account per channel per
  // tenant. Detect duplicates up front so we return a clean 409 instead of a
  // raw Prisma unique-constraint error.
  const existing = await prisma.connectAccount.findFirst({
    where: { tenantId, channel: req.channel },
  });
  if (existing) {
    throw new ConnectError(
      409,
      'channel_already_connected',
      `A ${req.channel} account is already connected for this tenant`,
    );
  }

  const account = await prisma.connectAccount.create({
    data: {
      tenantId,
      channel: req.channel,
      name: req.name.trim(),
      status: req.status ?? 'ACTIVE',
      config: req.config as object,
    },
  });

  logger.info(
    { accountId: account.id, channel: req.channel, tenantId },
    'Connect account created',
  );
  return toResponse(account);
}

// ── List connect accounts ──────────────────────────────────────────────────

export interface ChannelQuotaRow {
  channel: 'EMAIL' | 'SOCIAL';
  label: string;
  used: number;
  limit: number;
}

export interface ChannelQuota {
  plan: Plan;
  rows: ChannelQuotaRow[];
}

async function channelQuota(tenantId: string, plan: Plan): Promise<ChannelQuota> {
  const { emailInboxes, socialChannels } = planQuota(plan);
  const [emailCount, socialCount] = await Promise.all([
    prisma.connectAccount.count({ where: { tenantId, channel: 'EMAIL' } }),
    prisma.connectAccount.count({ where: { tenantId, channel: { in: ['LINKEDIN', 'WHATSAPP'] } } }),
  ]);
  return {
    plan,
    rows: [
      { channel: 'EMAIL', label: 'Email inbox', used: emailCount, limit: emailInboxes },
      { channel: 'SOCIAL', label: 'Social (LinkedIn + WhatsApp)', used: socialCount, limit: socialChannels },
    ],
  };
}

export async function listConnectAccounts(
  tenantId: string,
  plan: Plan,
  opts: { channel?: ConnectChannelType; status?: ConnectAccountStatus } = {},
): Promise<{ accounts: ConnectAccountResponse[]; quota: ChannelQuota }> {
  const where: { tenantId: string; channel?: ConnectChannelType; status?: ConnectAccountStatus } = {
    tenantId,
  };
  if (opts.channel) where.channel = opts.channel;
  if (opts.status) where.status = opts.status;

  const [accounts, quota] = await Promise.all([
    prisma.connectAccount.findMany({ where, orderBy: { createdAt: 'asc' } }),
    channelQuota(tenantId, plan),
  ]);
  return { accounts: accounts.map((a) => toResponse(a)), quota };
}

// ── Get a single account ────────────────────────────────────────────────────

export async function getConnectAccount(
  tenantId: string,
  accountId: string,
  opts: { revealSecrets?: boolean } = {},
): Promise<ConnectAccountResponse | null> {
  const acc = await prisma.connectAccount.findFirst({
    where: { id: accountId, tenantId },
  });
  return acc ? toResponse(acc, opts) : null;
}

// ── Update a connect account ───────────────────────────────────────────────

export interface UpdateConnectAccountRequest {
  name?: string;
  config?: Record<string, unknown>;
  status?: ConnectAccountStatus;
}

export async function updateConnectAccount(
  tenantId: string,
  accountId: string,
  req: UpdateConnectAccountRequest,
): Promise<ConnectAccountResponse> {
  const existing = await prisma.connectAccount.findFirst({
    where: { id: accountId, tenantId },
  });
  if (!existing) {
    throw new ConnectError(404, 'account_not_found', 'connect account not found');
  }
  if (req.config) {
    validateConfig(existing.channel, req.config);
  }
  // If a partial config is provided, merge it onto the existing config so the
  // caller doesn't have to resend the whole config to update one field.
  const mergedConfig =
    req.config !== undefined
      ? { ...(existing.config as Record<string, unknown>), ...(req.config as Record<string, unknown>) }
      : undefined;

  const updated = await prisma.connectAccount.update({
    where: { id: accountId },
    data: {
      ...(req.name ? { name: req.name.trim() } : {}),
      ...(mergedConfig ? { config: mergedConfig as object } : {}),
      ...(req.status ? { status: req.status } : {}),
    },
  });
  logger.info({ accountId, tenantId, channel: existing.channel }, 'Connect account updated');
  return toResponse(updated);
}

// ── Delete a connect account (hard delete — frees the channel slot) ─────────

export async function deleteConnectAccount(
  tenantId: string,
  accountId: string,
): Promise<{ ok: boolean; id: string; channel: ConnectChannelType }> {
  const existing = await prisma.connectAccount.findFirst({
    where: { id: accountId, tenantId },
  });
  if (!existing) {
    throw new ConnectError(404, 'account_not_found', 'connect account not found');
  }
  await prisma.connectAccount.delete({ where: { id: accountId } });
  logger.info(
    { accountId, tenantId, channel: existing.channel },
    'Connect account deleted',
  );
  return { ok: true, id: accountId, channel: existing.channel };
}

// ── Test the connection (verify the account can actually send) ─────────────

export interface TestResult {
  ok: boolean;
  channel: ConnectChannelType;
  accountId: string;
  status: 'verified' | 'failed';
  detail: string;
}

export async function testConnectAccount(
  tenantId: string,
  accountId: string,
): Promise<TestResult> {
  const acc = await prisma.connectAccount.findFirst({
    where: { id: accountId, tenantId },
  });
  if (!acc) {
    throw new ConnectError(404, 'account_not_found', 'connect account not found');
  }
  const config = (acc.config as Record<string, unknown>) ?? {};
  switch (acc.channel) {
    case 'EMAIL':
      return testEmail(acc.id, config);
    case 'WHATSAPP':
      return testWhatsApp(acc.id, config);
    case 'LINKEDIN':
      return testLinkedIn(acc.id, config);
  }
}

async function testEmail(
  accountId: string,
  config: Record<string, unknown>,
): Promise<TestResult> {
  // nodemailer.verify() opens a TCP+AUTH handshake and closes it without
  // sending anything — the cleanest "is this SMTP server reachable + auth'd"
  // probe we can do without sending a real email.
  const { createTransport } = await import('nodemailer');
  const transporter = createTransport({
    host: String(config.smtpHost),
    port: Number(config.smtpPort),
    secure: Boolean(config.smtpSecure ?? Number(config.smtpPort) === 465),
    auth: {
      user: String(config.smtpUser),
      pass: String(config.smtpPass),
    },
  });
  try {
    await transporter.verify();
    return {
      ok: true,
      channel: 'EMAIL',
      accountId,
      status: 'verified',
      detail: `SMTP ${config.smtpHost}:${config.smtpPort} reachable, credentials accepted`,
    };
  } catch (err) {
    return {
      ok: false,
      channel: 'EMAIL',
      accountId,
      status: 'failed',
      detail: err instanceof Error ? err.message : 'SMTP verification failed',
    };
  } finally {
    transporter.close();
  }
}

async function testWhatsApp(
  accountId: string,
  config: Record<string, unknown>,
): Promise<TestResult> {
  // GET /v{N}/{phoneNumberId} returns the registered display phone number when
  // the access token is valid — a cheap liveness probe that doesn't send.
  const apiVersion = (config.apiVersion as string) ?? 'v18.0';
  const url = `https://graph.facebook.com/${apiVersion}/${config.phoneNumberId}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return {
        ok: false,
        channel: 'WHATSAPP',
        accountId,
        status: 'failed',
        detail: `WhatsApp API ${res.status}: ${data.error?.message ?? res.statusText}`,
      };
    }
    const data = (await res.json()) as {
      display_phone_number?: string;
      verified_name?: string;
    };
    return {
      ok: true,
      channel: 'WHATSAPP',
      accountId,
      status: 'verified',
      detail: `WhatsApp number ${data.display_phone_number ?? config.phoneNumberId} verified (${data.verified_name ?? 'name unset'})`,
    };
  } catch (err) {
    return {
      ok: false,
      channel: 'WHATSAPP',
      accountId,
      status: 'failed',
      detail: err instanceof Error ? err.message : 'WhatsApp API unreachable',
    };
  }
}

async function testLinkedIn(
  accountId: string,
  config: Record<string, unknown>,
): Promise<TestResult> {
  // LinkedIn has no outbound API — automation runs through a Playwright
  // browser session driven by the stored cookie. Without Playwright wired we
  // can only sanity-check that a non-empty session cookie exists.
  const cookie = config.sessionCookie;
  if (typeof cookie !== 'string' || cookie.trim().length < 12) {
    return {
      ok: false,
      channel: 'LINKEDIN',
      accountId,
      status: 'failed',
      detail: 'sessionCookie missing or too short (expected li_at value, ≥12 chars)',
    };
  }
  return {
    ok: true,
    channel: 'LINKEDIN',
    accountId,
    status: 'verified',
    detail: 'LinkedIn session cookie present (Playwright verification deferred to MVP runtime)',
  };
}

// ── Mark account as RECONNECT_REQUIRED ─────────────────────────────────────
// Revor surfaces this state when a session/token expires. Dispatches to a
// reconnect-required account are blocked with a 409
// connect_account_reconnect_required (handled in dispatch.ts).

export async function markReconnectRequired(
  tenantId: string,
  accountId: string,
): Promise<ConnectAccountResponse> {
  const existing = await prisma.connectAccount.findFirst({
    where: { id: accountId, tenantId },
  });
  if (!existing) {
    throw new ConnectError(404, 'account_not_found', 'connect account not found');
  }
  const updated = await prisma.connectAccount.update({
    where: { id: accountId },
    data: { status: 'RECONNECT_REQUIRED' },
  });
  logger.warn(
    { accountId, tenantId, channel: existing.channel },
    'Connect account marked RECONNECT_REQUIRED',
  );
  return toResponse(updated);
}
