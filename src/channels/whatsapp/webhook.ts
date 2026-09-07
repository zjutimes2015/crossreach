import { verifySignature, parseWebhook } from './transform.js';
import type { ParsedInboundMessage, ParsedStatusUpdate } from '../types.js';
import { logger } from '../../utils/logger.js';

// ── GET Webhook Verification (subscription) ───────────────────────────────

/**
 * Meta sends a GET request with hub.* params when you first subscribe.
 * Returns the hub.challenge value if the verify_token matches.
 */
export function handleVerification(
  query: Record<string, string>,
  verifyToken: string,
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken) {
    logger.info('WhatsApp webhook verified successfully');
    return challenge;
  }

  logger.warn({ mode, token }, 'WhatsApp webhook verification failed');
  return null;
}

// ── POST Webhook Handler (incoming messages & status updates) ─────────────

export interface WebhookResult {
  messages: ParsedInboundMessage[];
  statuses: ParsedStatusUpdate[];
}

/**
 * Process an incoming WhatsApp webhook POST.
 * Verifies the signature, then parses the payload.
 */
export function handleWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): WebhookResult | null {
  // 1. Verify signature (skip in dev if no secret configured)
  if (appSecret) {
    const valid = verifySignature(rawBody, signatureHeader, appSecret);
    if (!valid) {
      logger.error('WhatsApp webhook signature verification failed');
      return null;
    }
  }

  // 2. Parse payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    logger.error('Failed to parse WhatsApp webhook body as JSON');
    return null;
  }

  // 3. Extract messages and statuses
  const result = parseWebhook(payload);
  logger.info(
    { messageCount: result.messages.length, statusCount: result.statuses.length },
    'WhatsApp webhook processed',
  );

  return result;
}
