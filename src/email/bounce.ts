// ── Bounce / complaint / delivery webhook parsers ────────────────────────────
// Normalize the common email-delivery providers' webhook payloads into one
// `EmailEventType` event shape so downstream health logic (deliverability.ts)
// doesn't care who delivered the message.
//
// Supported today: AWS SES (SNS notification), SendGrid Event Webhook (v3),
// Postmark webhooks, plus a naive generic fallback. All parsers are pure —
// no prisma or config imports — so they unit-test cleanly.

import type { EmailEventType } from '@prisma/client';

export type FeedbackEventType =
  | Extract<EmailEventType, 'DELIVERED' | 'BOUNCED_SOFT' | 'BOUNCED_HARD' | 'COMPLAINED' | 'UNSUBSCRIBED' | 'OPENED' | 'CLICKED'>;

export interface ParsedFeedbackEvent {
  type: FeedbackEventType;
  recipient?: string;
  messageId?: string;
  smtpCode?: number;
  detail?: string;
}

export type ParsedBounceResult =
  | { ok: true; provider: string; events: ParsedFeedbackEvent[] }
  | { ok: false; provider: string; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ── AWS SES (wrapped in an SNS notification) ───────────────────────────────

export function parseSes(body: unknown): ParsedBounceResult {
  try {
    const root = isRecord(body) ? body : {};
    // SNS topics deliver { Type: "Notification", Message: "<json string>" }.
    let msg: unknown = root.Message ?? root;
    if (typeof msg === 'string') msg = JSON.parse(msg);
    if (!isRecord(msg)) return { ok: false, provider: 'ses', error: 'unexpected SES payload' };

    const mail = isRecord(msg.mail)
      ? {
          messageId: typeof msg.mail.messageId === 'string' ? msg.mail.messageId : undefined,
          headers: Array.isArray(msg.mail.headers)
            ? (msg.mail.headers as unknown[])
            : undefined,
        }
      : {};

    const events: ParsedFeedbackEvent[] = [];
    const notificationType = msg.notificationType as string | undefined;

    if (notificationType === 'Delivery' && isRecord(msg.delivery)) {
      for (const r of Array.isArray(msg.delivery.recipients) ? (msg.delivery.recipients as unknown[]) : []) {
        events.push({ type: 'DELIVERED', recipient: String(r) });
      }
    }

    if (notificationType === 'Bounce' && isRecord(msg.bounce)) {
      const hard = (msg.bounce.bounceType as string | undefined) === 'Permanent';
      const list = Array.isArray(msg.bounce.bouncedRecipients)
        ? (msg.bounce.bouncedRecipients as unknown[])
        : [];
      for (const item of list) {
        const r = isRecord(item) ? item : {};
        const code = typeof r.status === 'string' ? Number.parseInt(r.status, 10) : undefined;
        events.push({
          type: hard ? 'BOUNCED_HARD' : 'BOUNCED_SOFT',
          recipient: typeof r.emailAddress === 'string' ? r.emailAddress : undefined,
          smtpCode: Number.isFinite(code) ? code : undefined,
          detail: [
            typeof r.action === 'string' ? r.action : undefined,
            typeof r.diagnosticCode === 'string' ? r.diagnosticCode : undefined,
          ]
            .filter(Boolean)
            .join(': ') || undefined,
        });
      }
      if (events.length === 0) {
        events.push({
          type: hard ? 'BOUNCED_HARD' : 'BOUNCED_SOFT',
          detail: `SEX bounce (${msg.bounce.bounceType ?? 'unknown'})`,
        });
      }
    }

    if (notificationType === 'Complaint' && isRecord(msg.complaint)) {
      const list = Array.isArray(msg.complaint.complainedRecipients)
        ? (msg.complaint.complainedRecipients as unknown[])
        : [];
      for (const r of list) {
        events.push({
          type: 'COMPLAINED',
          recipient: isRecord(r) && typeof r.emailAddress === 'string' ? r.emailAddress : undefined,
        });
      }
      if (events.length === 0) events.push({ type: 'COMPLAINED' });
    }

    // Attach messageId (hence attribution) to every inbound event.
    for (const e of events) if (mail.messageId) e.messageId = mail.messageId;
    return { ok: true, provider: 'ses', events };
  } catch (err) {
    return { ok: false, provider: 'ses', error: err instanceof Error ? err.message : String(err) };
  }
}

// ── SendGrid Event Webhook v3 ───────────────────────────────────────────────

const SENDGRID_EVENT_MAP: Record<string, FeedbackEventType> = {
  delivered: 'DELIVERED',
  bounce: 'BOUNCED_HARD',
  dropped: 'BOUNCED_HARD',
  deferred: 'BOUNCED_SOFT',
  spamreport: 'COMPLAINED',
  unsubscribe: 'UNSUBSCRIBED',
  group_unsubscribe: 'UNSUBSCRIBED',
  open: 'OPENED',
  click: 'CLICKED',
};

export function parseSendGrid(body: unknown): ParsedBounceResult {
  if (!Array.isArray(body)) return { ok: false, provider: 'sendgrid', error: 'expected an array of events' };
  const events: ParsedFeedbackEvent[] = [];
  for (const raw of body) {
    const ev = isRecord(raw) ? raw : {};
    const kind = SENDGRID_EVENT_MAP[ev.event as string];
    if (!kind) continue;
    events.push({
      type: kind,
      recipient: typeof ev.email === 'string' ? ev.email : undefined,
      messageId: typeof ev.sg_message_id === 'string' ? ev.sg_message_id : undefined,
      smtpCode: typeof ev.status === 'number' ? ev.status : undefined,
      detail: typeof ev.reason === 'string' ? ev.reason : undefined,
    });
  }
  return { ok: true, provider: 'sendgrid', events };
}

// ── Postmark ────────────────────────────────────────────────────────────────

const POSTMARK_MAP: Record<string, FeedbackEventType> = {
  Bounce: 'BOUNCED_HARD',
  BounceSoft: 'BOUNCED_SOFT',
  SpamComplaint: 'COMPLAINED',
  Open: 'OPENED',
  Click: 'CLICKED',
  Delivery: 'DELIVERED',
  Unsubscribe: 'UNSUBSCRIBED',
};

export function parsePostmark(body: unknown): ParsedBounceResult {
  if (!isRecord(body)) return { ok: false, provider: 'postmark', error: 'expected an object' };
  const kind = POSTMARK_MAP[body.RecordType as string];
  if (!kind) return { ok: false, provider: 'postmark', error: `unsupported RecordType=${String(body.RecordType)}` };
  const event: ParsedFeedbackEvent = {
    type: kind,
    recipient: typeof body.Email === 'string' ? body.Email : undefined,
    messageId: typeof body.MessageID === 'string' ? body.MessageID : undefined,
    detail: typeof body.Description === 'string' ? body.Description : undefined,
  };
  if (body.Type === 'Transient') event.type = 'BOUNCED_SOFT';
  return { ok: true, provider: 'postmark', events: [event] };
}

// ── Generic fallback: { event: "bounce|complaint|delivered|...", to, reason } ─

const GENERIC_MAP: Record<string, FeedbackEventType> = {
  bounce: 'BOUNCED_HARD',
  hard_bounce: 'BOUNCED_HARD',
  soft_bounce: 'BOUNCED_SOFT',
  complaint: 'COMPLAINED',
  delivered: 'DELIVERED',
  unsubscribe: 'UNSUBSCRIBED',
  open: 'OPENED',
  click: 'CLICKED',
};

export function parseGeneric(body: unknown): ParsedBounceResult {
  const ev = isRecord(body) ? body : {};
  const key = String(
    (ev.event as string) ?? (ev.type as string) ?? (ev.notificationType as string) ??
    (ev.RecordType as string) ?? '',
  ).toLowerCase();
  const kind: FeedbackEventType | undefined =
    GENERIC_MAP[key] ?? POSTMARK_MAP[key] ?? undefined;
  if (!kind) return { ok: false, provider: 'generic', error: `unsupported event kind="${key}"` };
  return {
    ok: true,
    provider: 'generic',
    events: [
      {
        type: kind,
        recipient: (ev.email ?? ev.to ?? ev.recipient ?? ev.Email) as string | undefined,
        detail: (ev.reason ?? ev.description) as string | undefined,
      },
    ],
  };
}

// ── Entry point: try the structured providers first, sink to generic ─────────

export function parseBounceWebhook(body: unknown): ParsedBounceResult {
  if (isRecord(body) && typeof body.Message === 'string') return parseSes(body);
  if (Array.isArray(body)) return parseSendGrid(body);
  if (isRecord(body) && (body.RecordType || body.MessageID)) return parsePostmark(body);
  return parseGeneric(body);
}