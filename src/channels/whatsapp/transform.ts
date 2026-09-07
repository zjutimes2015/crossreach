import crypto from 'node:crypto';
import type {
  MessageContent,
  ParsedInboundMessage,
  ParsedStatusUpdate,
} from '../types.js';

// ── WhatsApp Webhook Payload Types ────────────────────────────────────────

interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      field: string;
      value: {
        messaging_product?: string;
        metadata?: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: Array<WhatsAppRawMessage>;
        statuses?: Array<WhatsAppRawStatus>;
      };
    }>;
  }>;
}

interface WhatsAppRawMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string; mime_type: string; sha256: string };
  audio?: { id: string; mime_type: string; sha256: string; voice?: boolean };
  video?: { id: string; caption?: string; mime_type: string; sha256: string };
  document?: { id: string; caption?: string; filename: string; mime_type: string; sha256: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  button?: { text: string; payload: string };
  interactive?:
    | { type: 'button_reply'; button_reply: { id: string; title: string } }
    | { type: 'list_reply'; list_reply: { id: string; title: string; description: string } };
}

interface WhatsAppRawStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
}

// ── Parse inbound webhook ─────────────────────────────────────────────────

export function parseWebhook(
  rawPayload: unknown,
): { messages: ParsedInboundMessage[]; statuses: ParsedStatusUpdate[] } {
  const payload = rawPayload as WhatsAppWebhookPayload;
  const messages: ParsedInboundMessage[] = [];
  const statuses: ParsedStatusUpdate[][] = [];

  if (payload.object !== 'whatsapp_business_account') {
    return { messages: [], statuses: [] };
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;

      const { metadata, contacts, messages: rawMessages, statuses: rawStatuses } = change.value;
      if (!metadata?.phone_number_id) continue;

      const phoneNumberId = metadata.phone_number_id;

      // Build a contact lookup map (wa_id → name)
      const contactMap = new Map<string, string>();
      for (const c of contacts ?? []) {
        contactMap.set(c.wa_id, c.profile?.name);
      }

      // Parse messages
      for (const msg of rawMessages ?? []) {
        const parsed = parseMessage(msg, phoneNumberId, contactMap);
        if (parsed) messages.push(parsed);
      }

      // Parse status updates
      if (rawStatuses) {
        statuses.push(parseStatuses(rawStatuses, phoneNumberId));
      }
    }
  }

  return { messages, statuses: statuses.flat() };
}

function parseMessage(
  msg: WhatsAppRawMessage,
  phoneNumberId: string,
  contacts: Map<string, string>,
): ParsedInboundMessage | null {
  const content = extractContent(msg);
  if (!content) return null;

  return {
    channelIdentifier: phoneNumberId,
    externalCustomerId: msg.from,
    customerName: contacts.get(msg.from),
    externalMessageId: msg.id,
    timestamp: new Date(parseInt(msg.timestamp) * 1000),
    type: msg.type,
    content,
    rawPayload: msg,
  };
}

function extractContent(msg: WhatsAppRawMessage): MessageContent | null {
  switch (msg.type) {
    case 'text':
      if (!msg.text) return null;
      return { kind: 'text', text: msg.text.body };

    case 'image':
      if (!msg.image) return null;
      return { kind: 'image', mediaId: msg.image.id, caption: msg.image.caption };

    case 'audio':
      if (!msg.audio) return null;
      return { kind: 'audio', mediaId: msg.audio.id };

    case 'video':
      if (!msg.video) return null;
      return { kind: 'video', mediaId: msg.video.id, caption: msg.video.caption };

    case 'document':
      if (!msg.document) return null;
      return {
        kind: 'document',
        mediaId: msg.document.id,
        caption: msg.document.caption,
        filename: msg.document.filename,
      };

    case 'location':
      if (!msg.location) return null;
      return {
        kind: 'location',
        latitude: msg.location.latitude,
        longitude: msg.location.longitude,
        name: msg.location.name,
        address: msg.location.address,
      };

    case 'button':
      if (!msg.button) return null;
      return {
        kind: 'button_reply',
        buttonId: msg.button.payload,
        buttonText: msg.button.text,
      };

    case 'interactive':
      if (!msg.interactive) return null;
      if (msg.interactive.type === 'button_reply') {
        return {
          kind: 'button_reply',
          buttonId: msg.interactive.button_reply.id,
          buttonText: msg.interactive.button_reply.title,
        };
      }
      if (msg.interactive.type === 'list_reply') {
        return {
          kind: 'button_reply',
          buttonId: msg.interactive.list_reply.id,
          buttonText: msg.interactive.list_reply.title,
        };
      }
      return null;

    default:
      return null;
  }
}

function parseStatuses(
  rawStatuses: WhatsAppRawStatus[],
  phoneNumberId: string,
): ParsedStatusUpdate[] {
  return rawStatuses.map((s) => ({
    channelIdentifier: phoneNumberId,
    externalMessageId: s.id,
    status: s.status,
    timestamp: new Date(parseInt(s.timestamp) * 1000),
  }));
}

// ── Format outbound message for WhatsApp API ──────────────────────────────

export function formatOutbound(content: MessageContent): Record<string, unknown> {
  switch (content.kind) {
    case 'text':
      return { type: 'text', text: { body: content.text } };

    case 'image':
      return {
        type: 'image',
        image: { id: content.mediaId, ...(content.caption ? { caption: content.caption } : {}) },
      };

    case 'audio':
      return { type: 'audio', audio: { id: content.mediaId } };

    case 'video':
      return {
        type: 'video',
        video: { id: content.mediaId, ...(content.caption ? { caption: content.caption } : {}) },
      };

    case 'document':
      return {
        type: 'document',
        document: {
          id: content.mediaId,
          filename: content.filename ?? 'document',
          ...(content.caption ? { caption: content.caption } : {}),
        },
      };

    case 'location':
      return {
        type: 'location',
        location: {
          latitude: content.latitude,
          longitude: content.longitude,
          ...(content.name ? { name: content.name } : {}),
          ...(content.address ? { address: content.address } : {}),
        },
      };

    case 'template':
      return {
        type: 'template',
        template: {
          name: content.templateName,
          language: { code: content.language },
          ...(content.components ? { components: content.components } : {}),
        },
      };

    case 'interactive':
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: content.body },
          action: {
            buttons: content.buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };

    case 'button_reply':
      // button_reply is only for inbound; shouldn't be sent outbound
      throw new Error('button_reply content cannot be sent outbound');

    default:
      throw new Error(`Unsupported content kind for outbound: ${(content as { kind: string }).kind}`);
  }
}

// ── Webhook Signature Verification (HMAC-SHA256) ──────────────────────────

export function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader) return false;

  const expected = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7)
    : signatureHeader;

  const hmac = crypto.createHmac('sha256', appSecret);
  hmac.update(rawBody);
  const computed = hmac.digest('hex');

  // Timing-safe comparison
  if (expected.length !== computed.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(computed));
}
