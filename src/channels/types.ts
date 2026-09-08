// ── Unified Message Content (channel-agnostic) ────────────────────────────

export type MessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mediaId: string; caption?: string }
  | { kind: 'audio'; mediaId: string }
  | { kind: 'video'; mediaId: string; caption?: string }
  | { kind: 'document'; mediaId: string; caption?: string; filename?: string }
  | {
      kind: 'location';
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    }
  | {
      kind: 'template';
      templateName: string;
      language: string;
      components?: unknown[];
    }
  | {
      kind: 'interactive';
      body: string;
      buttons: { id: string; title: string }[];
    }
  | {
      kind: 'button_reply';
      buttonId: string;
      buttonText: string;
    };

// ── Unified Inbound / Outbound Messages ───────────────────────────────────

export interface ParsedInboundMessage {
  /** Channel-specific identifier (e.g. WhatsApp phone_number_id) used to look up the tenant/channel */
  channelIdentifier: string;
  /** External customer ID at the source channel (e.g. WhatsApp phone number, IG PSID) */
  externalCustomerId: string;
  customerName?: string;
  /** Original message ID from the channel */
  externalMessageId: string;
  timestamp: Date;
  type: string;
  content: MessageContent;
  rawPayload: unknown;
}

export interface ParsedStatusUpdate {
  channelIdentifier: string;
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
}

export interface OutboundMessage {
  to: string;
  content: MessageContent;
}

export interface SendResult {
  externalMessageId: string;
  status: 'sent' | 'failed';
  /** Human-readable failure reason when status === 'failed' */
  error?: string;
}

// ── Channel Adapter Interface ─────────────────────────────────────────────

export interface ChannelAdapter {
  /** Channel type this adapter handles */
  readonly type: string;

  /** Parse a raw webhook payload into unified inbound messages + status updates */
  parseWebhook(payload: unknown): {
    messages: ParsedInboundMessage[];
    statuses: ParsedStatusUpdate[];
  };

  /** Send an outbound message via the channel's API */
  send(
    message: OutboundMessage,
    channelConfig: Record<string, unknown>,
  ): Promise<SendResult>;

  /** Verify webhook subscription (Meta-style GET verification) */
  verifySubscription?(query: Record<string, string>): string | null;
}

// ── WhatsApp Channel Config (stored in Channel.config JSON) ───────────────

export interface WhatsAppChannelConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  wabaId?: string;
  phoneNumber?: string;
  apiVersion?: string;
}
