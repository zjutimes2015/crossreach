// ── Email adapter (SMTP via nodemailer) ────────────────────────────────────
// Connect account config shape:
//   { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, fromAddress, fromName }

import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '../../utils/logger.js';

export interface EmailAccountConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  fromAddress: string;
  fromName?: string;
}

export interface EmailRecipient {
  address: string;
  name?: string;
}

export interface EmailContent {
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType?: string;
  }>;
  // Custom message headers (e.g. the X-CrossReach-Token used for bounce attribution)
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  messageId: string;
  status: 'sent' | 'failed';
  error?: string;
}

// Cache transporters per account to avoid re-creating SMTP connections
const transporterCache = new Map<string, Transporter>();

function getTransporter(config: EmailAccountConfig): Transporter {
  const cacheKey = `${config.smtpUser}@${config.smtpHost}:${config.smtpPort}`;
  let transporter = transporterCache.get(cacheKey);
  if (transporter) return transporter;

  transporter = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });

  transporterCache.set(cacheKey, transporter);
  return transporter;
}

/**
 * Send an email via SMTP.
 * Mirrors Revor's outreach.dispatch for channel=email.
 */
export async function sendEmail(
  config: EmailAccountConfig,
  to: EmailRecipient,
  content: EmailContent,
): Promise<EmailSendResult> {
  try {
    const transporter = getTransporter(config);
    const info = await transporter.sendMail({
      from: config.fromName
        ? `"${config.fromName}" <${config.fromAddress}>`
        : config.fromAddress,
      to: to.name ? `"${to.name}" <${to.address}>` : to.address,
      subject: content.subject,
      text: content.text,
      html: content.html,
      headers: content.headers,
      attachments: content.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, 'base64'),
        contentType: a.contentType,
      })),
    });

    logger.info({ messageId: info.messageId, to: to.address }, 'Email sent');
    return { messageId: info.messageId, status: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, to: to.address }, 'Email send failed');
    return { messageId: '', status: 'failed', error: message };
  }
}
