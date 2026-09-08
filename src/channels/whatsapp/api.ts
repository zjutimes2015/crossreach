import { formatOutbound } from './transform.js';
import type { MessageContent, OutboundMessage, SendResult } from '../types.js';
import type { WhatsAppChannelConfig } from '../types.js';
import { logger } from '../../utils/logger.js';

const GRAPH_API_BASE = 'https://graph.facebook.com';

interface GraphApiResponse {
  messaging_product: string;
  contacts?: Array<{ wa_id: string; input: string }>;
  messages?: Array<{ id: string }>;
  error?: { message: string; code: number; type: string };
}

/**
 * Send a message via WhatsApp Business Cloud API.
 * POST /{phone_number_id}/messages
 */
export async function sendWhatsAppMessage(
  config: WhatsAppChannelConfig,
  message: OutboundMessage,
): Promise<SendResult> {
  const apiVersion = config.apiVersion ?? 'v18.0';
  const url = `${GRAPH_API_BASE}/${apiVersion}/${config.phoneNumberId}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: message.to,
    ...formatOutbound(message.content),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as GraphApiResponse;

    if (!response.ok || data.error) {
      const reason = data.error?.message ?? `WhatsApp API responded ${response.status}`;
      logger.error(
        { error: data.error, status: response.status },
        'WhatsApp API send failed',
      );
      return { externalMessageId: '', status: 'failed', error: reason };
    }

    const messageId = data.messages?.[0]?.id ?? '';
    return { externalMessageId: messageId, status: 'sent' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'WhatsApp API request threw';
    logger.error({ err }, 'WhatsApp API request threw');
    return { externalMessageId: '', status: 'failed', error: reason };
  }
}

/**
 * Download media metadata (returns a temporary URL valid for ~10 minutes).
 * GET /{media_id}
 */
export async function getMediaUrl(
  config: WhatsAppChannelConfig,
  mediaId: string,
): Promise<string | null> {
  const apiVersion = config.apiVersion ?? 'v18.0';
  const url = `${GRAPH_API_BASE}/${apiVersion}/${mediaId}`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    const data = (await response.json()) as { url?: string; id?: string; error?: unknown };
    return data.url ?? null;
  } catch (err) {
    logger.error({ err, mediaId }, 'Failed to fetch WhatsApp media URL');
    return null;
  }
}

/**
 * Convenience: send a simple text message.
 */
export async function sendText(
  config: WhatsAppChannelConfig,
  to: string,
  text: string,
): Promise<SendResult> {
  const content: MessageContent = { kind: 'text', text };
  return sendWhatsAppMessage(config, { to, content });
}

/**
 * Convenience: send a template message (for proactive outreach / 拓客).
 * Templates must be pre-approved in Meta Business Manager.
 */
export async function sendTemplate(
  config: WhatsAppChannelConfig,
  to: string,
  templateName: string,
  language: string,
  components?: unknown[],
): Promise<SendResult> {
  const content: MessageContent = {
    kind: 'template',
    templateName,
    language,
    components,
  };
  return sendWhatsAppMessage(config, { to, content });
}

/**
 * Convenience: send an interactive message with buttons.
 */
export async function sendInteractiveButtons(
  config: WhatsAppChannelConfig,
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
): Promise<SendResult> {
  const content: MessageContent = { kind: 'interactive', body, buttons };
  return sendWhatsAppMessage(config, { to, content });
}
