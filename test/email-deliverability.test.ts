// Email deliverability hardening — pure-logic tests (no DB required).
import { describe, expect, it } from 'vitest';
import {
  parseBounceWebhook,
  parseSes,
  parseSendGrid,
  parsePostmark,
  parseGeneric,
} from '../src/email/bounce.js';
import {
  generateTrackingToken,
  trackUrls,
  injectTracking,
} from '../src/email/tracking.js';
import {
  dailyWindowStart,
  healthWindowStart,
  bounceRate,
  assessHealth,
  dailyLimitOf,
  DEFAULT_DAILY_LIMIT,
} from '../src/email/deliverability.js';
import type { ConnectAccount } from '@prisma/client';

function fakeAccount(config: Record<string, unknown>): ConnectAccount {
  return { config } as unknown as ConnectAccount;
}

describe('email tracking', () => {
  it('generates unique opaque tokens', () => {
    const a = generateTrackingToken();
    const b = generateTrackingToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('builds open / click / unsubscribe URLs under the base', () => {
    const { open, click, unsubscribe } = trackUrls('https://app.example.com', 't0k3n');
    expect(open).toBe('https://app.example.com/_track/t0k3n/open.gif');
    expect(click).toBe('https://app.example.com/_track/t0k3n/click');
    expect(unsubscribe).toBe('https://app.example.com/_track/t0k3n/unsubscribe');
  });

  it('injects the open pixel and wraps absolute links', () => {
    const html = '<a href="https://example.com/checkout?x=1">Buy</a><p>hi</p></body>';
    const out = injectTracking(html, 'https://app.example.com', 'tok');
    // links go through the click redirector with the target URL-encoded
    expect(out).toContain('href="https://app.example.com/_track/tok/click?url=');
    expect(out).toContain('%2Fcheckout%3Fx%3D1');
    // pixel appended before </body>
    expect(out).toContain('/_track/tok/open.gif');
    expect(out.indexOf('/_track/tok/open.gif')).toBeLessThan(out.indexOf('</body>'));
  });

  it('leaves non-HTML text bodies unchanged', () => {
    const plain = 'just text, no html';
    expect(injectTracking(plain, 'https://x.com', 'tok')).toBe(plain + '<img src="https://x.com/_track/tok/open.gif" width="1" height="1" alt="" style="display:none;width:1px;height:1px;"/>');
  });
});

describe('deliverability math (daily quota / health)', () => {
  it('computes UTC day and rolling health window boundaries', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(dailyWindowStart(now).toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(healthWindowStart(7, now).toISOString()).toBe('2026-06-08T12:00:00.000Z');
  });

  it('bounds bounce rate to [0,1] and guards division by zero', () => {
    expect(bounceRate(0, 5)).toBe(0);
    expect(bounceRate(100, 10)).toBeCloseTo(0.1);
    expect(bounceRate(100, 999)).toBe(1);
  });

  it('flags BYO account healthy and breaches bounce/complaint thresholds', () => {
    expect(assessHealth(0, 0, 0)).toEqual({ ok: true });
    // 6% hard bounce of 100 sent > 5% threshold → pause
    expect(assessHealth(100, 6, 0)).toEqual({ ok: false, reason: 'bounce_rate' });
    // complaint rate above 0.1%
    expect(assessHealth(1000, 0, 2)).toEqual({ ok: false, reason: 'complaint_rate' });
    // right at/past boundary
    expect(assessHealth(100, 5, 0)).toEqual({ ok: true });
  });

  it('honors a per-account dailyLimit override, else the default', () => {
    expect(dailyLimitOf(fakeAccount({ dailyLimit: 20 }))).toBe(20);
    expect(dailyLimitOf(fakeAccount({ dailyLimit: '150' }))).toBe(150);
    expect(dailyLimitOf(fakeAccount({ dailyLimit: -3 }))).toBe(DEFAULT_DAILY_LIMIT);
    expect(dailyLimitOf(fakeAccount({}))).toBe(DEFAULT_DAILY_LIMIT);
  });
});

describe('bounce webhook parsers', () => {
  it('parses an AWS SES SNS bounce envelope', () => {
    const body = {
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [
            { emailAddress: 'bad@example.com', status: '5.1.1', action: 'failed', diagnosticCode: '550 mailbox not found' },
          ],
        },
        mail: { messageId: 'ses-id-123', headers: [] },
      }),
    };
    const res = parseSes(body);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.provider).toBe('ses');
    expect(res.events).toEqual([
      {
        type: 'BOUNCED_HARD',
        recipient: 'bad@example.com',
        smtpCode: 5,
        detail: expect.stringContaining('550'),
        messageId: 'ses-id-123',
      },
    ]);
  });

  it('parses an SES complaint as COMPLAINED', () => {
    const res = parseSes({
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Complaint',
        complaint: { complainedRecipients: [{ emailAddress: 'sour@example.com' }] },
        mail: { messageId: 'ses-id', headers: [] },
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events[0]).toMatchObject({ type: 'COMPLAINED', recipient: 'sour@example.com', messageId: 'ses-id' });
  });

  it('parses a SendGrid event-array with bounce/spamreport/delivered', () => {
    const res = parseSendGrid([
      { event: 'delivered', email: 'ok@example.com', sg_message_id: 'sg1' },
      { event: 'bounce', email: 'bad@example.com', sg_message_id: 'sg2', reason: '550 denied', status: 550 },
      { event: 'spamreport', email: 'meh@example.com' },
      { event: 'open', email: 'reader@example.com' },
      { event: 'unsupported_event', email: 'x@example.com' },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events).toHaveLength(4);
    expect(res.events[1]).toMatchObject({ type: 'BOUNCED_HARD', recipient: 'bad@example.com', smtpCode: 550, detail: '550 denied' });
    expect(res.events[2].type).toBe('COMPLAINED');
    expect(res.events[3].type).toBe('OPENED');
  });

  it('parses a Postmark bounce and transient bounce', () => {
    const res = parsePostmark({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'bad@example.com', MessageID: 'p1', Description: 'hard' });
    const soft = parsePostmark({ RecordType: 'Bounce', Type: 'Transient', Email: 'soft@example.com' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events[0].type).toBe('BOUNCED_HARD');
    expect(soft.ok).toBe(true);
    if (soft.ok) expect(soft.events[0].type).toBe('BOUNCED_SOFT');
  });

  it('falls back to generic for unknown shapes and rejects unsupported kinds', () => {
    const ok = parseGeneric({ event: 'complaint', email: 'a@example.com' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.events[0].type).toBe('COMPLAINED');
    const bad = parseGeneric({ event: 'foo' });
    expect(bad.ok).toBe(false);
  });

  it('routes SNS-wrap, arrays, and record payloads through the entry point', () => {
    expect(parseBounceWebhook({ Type: 'Notification', Message: '{}' }).provider).toBe('ses');
    expect(parseBounceWebhook([{ event: 'bounce', email: 'a@e.com' }]).provider).toBe('sendgrid');
    expect(parseBounceWebhook({ RecordType: 'Open', MessageID: 'x' }).provider).toBe('postmark');
    expect(parseBounceWebhook({ event: 'bounce' }).provider).toBe('generic');
  });

  it('keeps an SES bounce with no recipients as a typed event', () => {
    const res = parseSes({
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [] },
        mail: { messageId: 'm', headers: [] },
      }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.events[0].type).toBe('BOUNCED_HARD');
  });
});