// ── Hardened email send ─────────────────────────────────────────────────────
// The single path outbound email goes through. Composes the deliverability
// guards + tracking instrumentation + event ledger around the raw SMTP adapter:
//
//   assertCanSend(account)      quota / pacing / health-pause gate
//   → createTrackingToken       one opaque token per send
//   → injectTracking(html)      open pixel + click-through links
//   → sendEmail(..., header)    SMTP with the X-CrossReach-Token header
//   → record SENT + save messageId   append to the same ledger quota reads
//
// This is what outreach dispatch (src/modules/outreach/dispatch.ts) calls for
// channel=email instead of the bare adapter.

import { sendEmail } from '../channels/email/api.js';
import type { EmailAccountConfig, EmailRecipient } from '../channels/email/api.js';
import {
  assertCanSend,
  DeliverabilityError,
} from './deliverability.js';
import {
  createTrackingToken,
  injectTracking,
  recordEmailEvent,
  TRACK_HEADER,
} from './tracking.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import type { ConnectAccount } from '@prisma/client';

export interface DeliverabilitySendOptions {
  recipient: EmailRecipient;
  subject: string;
  text?: string;
  html?: string;
  attachments?: SendAttachment[];
  /** LINK-back to an outreach job / customer for attribution & stopIfReplied. */
  jobId?: string;
  customerId?: string;
  /** Public base URL used to render tracking links. */
  baseUrl: string;
}

interface SendAttachment {
  filename: string;
  contentBase64: string;
  contentType?: string;
}

export interface DeliverabilitySendResult {
  messageId: string;
  trackToken: string;
}

/**
 * Send one email through the guarded pipeline. Throws `DeliverabilityError`
 * (with `.retryable`) when a guard rejects the send; throws a plain `Error`
 * if SMTP actually fails. Callers that charged credits up-front should refund
 * on any throw.
 */
export async function sendWithDeliverability(
  account: ConnectAccount,
  tenantId: string,
  opts: DeliverabilitySendOptions,
): Promise<DeliverabilitySendResult> {
  // 1. Guards: cooldown pause → daily cap → pacing.
  await assertCanSend(account);

  // 2. One token per send — powers open/click/unsubscribe + bounce attribution.
  const token = await createTrackingToken({
    tenantId,
    accountId: account.id,
    jobId: opts.jobId,
    customerId: opts.customerId,
    recipient: opts.recipient.address,
    expiresInSec: 30 * 24 * 3600,
  });

  // 3. Instrument the HTML body (if present) with pixel + click redirects.
  const html = opts.html ? injectTracking(opts.html, opts.baseUrl, token) : undefined;

  const config = account.config as unknown as EmailAccountConfig;
  const result = await sendEmail(
    config,
    opts.recipient,
    {
      subject: opts.subject,
      text: opts.text,
      html,
      headers: { [TRACK_HEADER]: token },
      attachments: opts.attachments,
    },
  );

  if (result.status === 'failed') {
    throw new Error(result.error ?? 'Email send failed');
  }

  // 4. Persist the SENT event (the daily counter reads this) + resolve messageId.
  await recordEmailEvent({
    token,
    type: 'SENT',
    recipient: opts.recipient.address,
    accountId: account.id,
    messageId: result.messageId,
  });
  await prisma.emailTrackingToken
    .updateMany({ where: { token }, data: { messageId: result.messageId } })
    .catch(() => {});

  logger.info(
    { accountId: account.id, tenantId, token, messageId: result.messageId },
    'Email sent (deliverability pipeline)',
  );
  return { messageId: result.messageId, trackToken: token };
}

export { DeliverabilityError };