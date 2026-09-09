// ── Outreach Dispatch Service (对标 Revor POST /api/v1/outreach/dispatches) ─
// Creates a single email / LinkedIn / WhatsApp outreach task, returns a job
// ID immediately (HTTP 202 Accepted), and executes the job asynchronously.
// Status is then polled via GET /api/v1/outreach/jobs/:id.

import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import { sendWhatsAppMessage } from '../../channels/whatsapp/api.js';
import type { WhatsAppChannelConfig } from '../../channels/types.js';
import { sendWithDeliverability, DeliverabilityError } from '../../email/send.js';
import { pickEmailAccount } from '../../email/deliverability.js';
import { config } from '../../config/index.js';
import {
  sendLinkedInAction,
  likeRelevantPost,
} from '../../channels/linkedin/api.js';
import type { LinkedInAccountConfig } from '../../channels/linkedin/api.js';
import type {
  ConnectAccount,
  ConnectChannelType,
  OutreachAction,
  OutreachJobStatus,
  Plan,
} from '@prisma/client';
import { getBalance, chargeCredits, refundCredits } from '../billing/balance.js';
import {
  isSuppressed,
} from '../compliance/suppression.js';
import {
  ComplianceBlockedError,
  isComplianceBlocked,
} from '../compliance/errors.js';

// ── Dispatch request (mirrors Revor's request body) ──────────────────────

export interface DispatchRequest {
  connectAccountId: string;
  channel: ConnectChannelType;
  action?: OutreachAction;
  recipient: {
    address?: string;
    name?: string;
    profileUrl?: string;
    phone?: string;
  };
  content: {
    subject?: string;
    text?: string;
    html?: string;
    attachments?: Array<{
      filename: string;
      contentBase64: string;
      contentType?: string;
    }>;
  };
  metadata?: Record<string, unknown>;
  minChannelTaskIntervalSeconds?: number;
  scheduledAt?: string;
  idempotencyKey?: string;
}

// ── Dispatch response (mirrors Revor's response) ─────────────────────────

export interface DispatchResponse {
  ok: boolean;
  requestId: string;
  item: {
    id: string;
    status: OutreachJobStatus;
    action: string;
    channel: ConnectChannelType;
    scheduledAt: string | null;
  };
}

// ── Validation (mirrors Revor's 400 error codes) ──────────────────────────

export class DispatchError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function validateDispatch(req: DispatchRequest): void {
  if (!req.connectAccountId) {
    throw new DispatchError(400, 'account_id_required', 'connectAccountId is required');
  }
  if (!req.channel) {
    throw new DispatchError(400, 'invalid_channel', 'channel is required');
  }
  if (!req.action || req.action !== 'OUTREACH_DISPATCH') {
    // action defaults to OUTREACH_DISPATCH if omitted
  }

  switch (req.channel) {
    case 'EMAIL':
      if (!req.recipient.address) {
        throw new DispatchError(400, 'recipient_address_required', 'recipient.address is required for email');
      }
      if (!req.content.subject) {
        throw new DispatchError(400, 'content_subject_required', 'content.subject is required for email');
      }
      if (!req.content.text && !req.content.html) {
        throw new DispatchError(400, 'content_text_or_html_required', 'Email body (text or html) is required');
      }
      break;
    case 'LINKEDIN':
      if (!req.recipient.profileUrl) {
        throw new DispatchError(400, 'recipient_profile_url_required', 'recipient.profileUrl is required for LinkedIn');
      }
      if (!req.content.text && !(req.content.attachments?.length)) {
        throw new DispatchError(400, 'content_text_or_attachment_required', 'Text or attachment is required');
      }
      break;
    case 'WHATSAPP':
      if (!req.recipient.phone) {
        throw new DispatchError(400, 'recipient_phone_required', 'recipient.phone is required for WhatsApp');
      }
      if (!req.content.text && !(req.content.attachments?.length)) {
        throw new DispatchError(400, 'content_text_or_attachment_required', 'Text or attachment is required');
      }
      break;
  }
}

// ── Create a dispatch job ─────────────────────────────────────────────────

export async function createDispatch(
  tenantId: string,
  tenantPlan: Plan,
  req: DispatchRequest,
): Promise<DispatchResponse> {
  validateDispatch(req);

  // Resolve the connect account
  const account = await prisma.connectAccount.findFirst({
    where: { id: req.connectAccountId, tenantId },
  });

  if (!account) {
    throw new DispatchError(404, 'account_not_found', 'connectAccountId does not exist or is not accessible');
  }

  if (account.channel !== req.channel) {
    throw new DispatchError(409, 'account_channel_mismatch', 'connectAccountId does not match channel');
  }

  if (account.status === 'RECONNECT_REQUIRED') {
    throw new DispatchError(409, 'connect_account_reconnect_required', 'The account must be reconnected');
  }

  if (account.status === 'DISABLED') {
    throw new DispatchError(403, 'permission_denied', 'The account is disabled');
  }

  // Idempotency check
  if (req.idempotencyKey) {
    const existing = await prisma.outreachJob.findUnique({
      where: { idempotencyKey: req.idempotencyKey },
    });
    if (existing) {
      // Return the existing job (idempotent)
      return {
        ok: true,
        requestId: `req_${existing.id.slice(-8)}`,
        item: {
          id: existing.id,
          status: existing.status,
          action: existing.action.toLowerCase().replace(/_/g, '.'),
          channel: existing.channel,
          scheduledAt: existing.scheduledAt?.toISOString() ?? null,
        },
      };
    }
  }

  // ── Credit check: charge 1 OUTREACH_SEND credit upfront ─────────────────
  // Refunded inside executeJob if the send fails.
  const balance = await getBalance(tenantId, tenantPlan);
  if (balance.available < 1) {
    throw new DispatchError(402, 'insufficient_credits', 'Outreach dispatch requires 1 credit; balance is 0. Top up at /api/v1/billing/top-up.');
  }
  const charge = await chargeCredits(tenantId, tenantPlan, {
    resource: 'OUTREACH_SEND',
    count: 1,
    dimensions: { channel: req.channel, action: 'outreach_dispatch' },
    description: `Outreach dispatch — ${req.channel.toLowerCase()}`,
  });
  if (!charge.ok) {
    throw new DispatchError(402, 'insufficient_credits', charge.insufficient ? 'Insufficient credits' : 'Credit charge failed');
  }

  // Clamp interval to Revor's bounds: 60–86400 seconds
  const minInterval = Math.max(60, Math.min(86400, req.minChannelTaskIntervalSeconds ?? 60));
  const scheduledAt = req.scheduledAt ? new Date(req.scheduledAt) : new Date();

  const job = await prisma.outreachJob.create({
    data: {
      tenantId,
      connectAccountId: account.id,
      action: 'OUTREACH_DISPATCH',
      channel: req.channel,
      status: req.scheduledAt ? 'SCHEDULED' : 'QUEUED',
      recipient: req.recipient as object,
      content: req.content as object,
      metadata: { ...(req.metadata ?? {}), chargedCredits: 1 } as object,
      scheduledAt,
      minIntervalSeconds: minInterval,
      idempotencyKey: req.idempotencyKey,
    },
  });

  logger.info({ jobId: job.id, channel: req.channel, status: job.status }, 'Outreach job created');

  // Execute asynchronously (don't block the HTTP response — Revor returns 202)
  setImmediate(() => {
    executeJob(job.id).catch((err) => {
      logger.error({ err, jobId: job.id }, 'Outreach job execution failed');
    });
  });

  return {
    ok: true,
    requestId: `req_${job.id.slice(-8)}`,
    item: {
      id: job.id,
      status: job.status,
      action: 'outreach.dispatch',
      channel: req.channel,
      scheduledAt: job.scheduledAt?.toISOString() ?? null,
    },
  };
}

// ── Execute a job (called async after creation) ───────────────────────────

async function executeJob(jobId: string): Promise<void> {
  const job = await prisma.outreachJob.findUnique({
    where: { id: jobId },
    include: { connectAccount: true },
  });

  if (!job || !job.connectAccount) {
    logger.warn({ jobId }, 'Job or connect account not found');
    return;
  }

  // Mark running
  await prisma.outreachJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: new Date(), attemptCount: { increment: 1 } },
  });

  try {
    const result = await dispatchToChannel(job.connectAccount, job);

    await prisma.outreachJob.update({
      where: { id: jobId },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        result: result as object,
        connectAccount: { update: { lastUsedAt: new Date() } },
      },
    });

    logger.info({ jobId, result }, 'Outreach job succeeded');
  } catch (err) {
    // Compliance blocks (suppressed recipient) and deliverability guards carry
    // stable machine-readable codes; everything else falls back to the message.
    const error = jobErrorPayload(err);

    await prisma.outreachJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: error as object,
      },
    });

    // Refund the upfront-charged credit — the send did not succeed
    const meta = job.metadata as { chargedCredits?: number } | null;
    const charged = meta?.chargedCredits ?? 0;
    if (charged > 0) {
      await refundCredits(job.tenantId, charged, {
        resource: 'OUTREACH_SEND',
        jobId,
        description: `Outreach refund — send failed (${charged} credit${charged > 1 ? 's' : ''})`,
        metadata: { channel: job.channel, reason: String(error.code ?? 'action_failed') },
      });
    }

    logger.error({ jobId, err }, 'Outreach job failed');
  }
}

// ── Channel dispatch router ────────────────────────────────────────────────

async function dispatchToChannel(
  account: ConnectAccount,
  job: { channel: ConnectChannelType; recipient: unknown; content: unknown; action: OutreachAction },
): Promise<Record<string, unknown>> {
  const recipient = job.recipient as Record<string, string>;
  const content = job.content as Record<string, unknown>;

  switch (job.channel) {
    case 'EMAIL': {
      // Warm-up pool: pick the quietest healthy inbox on this tenant, then send
      // under its own quota/pacing guards. The caller-supplied account only
      // acts as a channel token — the actual SMTP box is chosen here.
      const inbox = await pickEmailAccount(account.tenantId);
      const result = await sendWithDeliverability(
        inbox,
        inbox.tenantId,
        {
          recipient: {
            address: recipient.address!,
            name: recipient.name,
          },
          subject: content.subject as string,
          text: content.text as string | undefined,
          html: content.html as string | undefined,
          attachments: content.attachments as
            | Array<{ filename: string; contentBase64: string; contentType?: string }>
            | undefined,
          jobId: (job as { id?: string }).id,
          baseUrl: config.PUBLIC_BASE_URL,
        },
      );
      return {
        accountId: inbox.id,
        channel: 'email',
        action: 'outreach',
        resolvedAction: 'message',
        messageId: result.messageId,
        trackToken: result.trackToken,
        status: 'accepted',
      };
    }

    case 'WHATSAPP': {
      // Compliance gate: never message a suppressed phone again.
      const suppressed = await isSuppressed(account.tenantId, 'WHATSAPP', recipient.phone!);
      if (suppressed) throw new ComplianceBlockedError(suppressed);

      const config = account.config as unknown as WhatsAppChannelConfig;
      const result = await sendWhatsAppMessage(config, {
        to: recipient.phone!,
        content: { kind: 'text', text: content.text as string },
      });
      if (result.status === 'failed') {
        throw new Error(result.error ?? 'WhatsApp message send failed');
      }
      return {
        accountId: account.id,
        channel: 'whatsapp',
        action: 'outreach',
        resolvedAction: 'message',
        messageId: result.externalMessageId,
        status: 'accepted',
      };
    }

    case 'LINKEDIN': {
      // Compliance gate: a suppressed profile must not be re-approached.
      const suppressed = await isSuppressed(account.tenantId, 'LINKEDIN', recipient.profileUrl!);
      if (suppressed) throw new ComplianceBlockedError(suppressed);

      const config = account.config as unknown as LinkedInAccountConfig;
      const result = await sendLinkedInAction(
        config,
        { profileUrl: recipient.profileUrl! },
        { text: content.text as string | undefined },
      );
      if (result.status === 'failed') {
        throw new Error(result.error ?? 'LinkedIn action failed');
      }
      return {
        accountId: account.id,
        channel: 'linkedin',
        action: 'outreach',
        resolvedAction: result.resolvedAction,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      };
    }

    default:
      throw new Error(`Unsupported channel: ${job.channel}`);
  }
}

// ── LinkedIn post-like dispatch (Revor: POST /api/v1/outreach/linkedin/post-likes) ─

/** Map any executor error to the persisted `OutreachJob.error` JSON shape. */
function jobErrorPayload(err: unknown): Record<string, unknown> {
  if (isComplianceBlocked(err)) {
    const s = err.suppression;
    return {
      code: err.code,
      message: err.message,
      retryable: false,
      // The matched suppression row is kept on the job as retrievable evidence.
      compliance: {
        suppressionId: s.id,
        reason: s.reason,
        contact: s.contact,
        since: s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt),
      },
    };
  }
  if (err instanceof DeliverabilityError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  return {
    code: 'action_failed',
    message: err instanceof Error ? err.message : 'The outreach action failed',
    retryable: false,
  };
}

export async function createLinkedInPostLike(
  tenantId: string,
  tenantPlan: Plan,
  req: {
    connectAccountId: string;
    profileUrl: string;
    topic?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<DispatchResponse> {
  const account = await prisma.connectAccount.findFirst({
    where: { id: req.connectAccountId, tenantId, channel: 'LINKEDIN' },
  });

  if (!account) {
    throw new DispatchError(404, 'account_not_found', 'connectAccountId does not exist or is not accessible');
  }
  if (account.status === 'RECONNECT_REQUIRED') {
    throw new DispatchError(409, 'connect_account_reconnect_required', 'The account must be reconnected');
  }

  // ── Credit check: 1 OUTREACH_SEND credit for the like action ────────────
  const balance = await getBalance(tenantId, tenantPlan);
  if (balance.available < 1) {
    throw new DispatchError(402, 'insufficient_credits', 'LinkedIn post-like requires 1 credit; balance is 0. Top up at /api/v1/billing/top-up.');
  }
  const charge = await chargeCredits(tenantId, tenantPlan, {
    resource: 'OUTREACH_SEND',
    count: 1,
    dimensions: { channel: 'LINKEDIN', action: 'post_like' },
    description: 'LinkedIn post like',
  });
  if (!charge.ok) {
    throw new DispatchError(402, 'insufficient_credits', charge.insufficient ? 'Insufficient credits' : 'Credit charge failed');
  }

  const job = await prisma.outreachJob.create({
    data: {
      tenantId,
      connectAccountId: account.id,
      action: 'OUTREACH_LINKEDIN_POST_LIKE',
      channel: 'LINKEDIN',
      status: 'QUEUED',
      recipient: { profileUrl: req.profileUrl } as object,
      content: { topic: req.topic } as object,
      metadata: { ...(req.metadata ?? {}), chargedCredits: 1 } as object,
    },
  });

  setImmediate(() => {
    executePostLike(job.id, account).catch((err) => {
      logger.error({ err, jobId: job.id }, 'LinkedIn post-like failed');
    });
  });

  return {
    ok: true,
    requestId: `req_${job.id.slice(-8)}`,
    item: {
      id: job.id,
      status: 'QUEUED',
      action: 'outreach.linkedin.post_like',
      channel: 'LINKEDIN',
      scheduledAt: null,
    },
  };
}

async function executePostLike(jobId: string, account: ConnectAccount): Promise<void> {
  const job = await prisma.outreachJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  await prisma.outreachJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: new Date(), attemptCount: { increment: 1 } },
  });

  try {
    const recipient = job.recipient as { profileUrl: string };

    // Compliance gate: skip profiles the tenant is no longer allowed to touch.
    const suppressed = await isSuppressed(account.tenantId, 'LINKEDIN', recipient.profileUrl);
    if (suppressed) throw new ComplianceBlockedError(suppressed);

    const config = account.config as unknown as LinkedInAccountConfig;
    const result = await likeRelevantPost(config, recipient.profileUrl);

    await prisma.outreachJob.update({
      where: { id: jobId },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        result: { status: result.status } as object,
      },
    });
  } catch (err) {
    await prisma.outreachJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: jobErrorPayload(err) as object,
      },
    });

    const meta = job.metadata as { chargedCredits?: number } | null;
    const charged = meta?.chargedCredits ?? 0;
    if (charged > 0) {
      await refundCredits(job.tenantId, charged, {
        resource: 'OUTREACH_SEND',
        jobId,
        description: `LinkedIn post-like refund — failed (${charged} credit)`,
        metadata: { channel: 'LINKEDIN', reason: 'post_like_failed' },
      });
    }
    logger.error({ err, jobId }, 'LinkedIn post-like failed');
  }
}
