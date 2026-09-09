import { describe, expect, it } from 'vitest';
import {
  normalizeContact,
  findSuppressionMatch,
} from '../src/modules/compliance/suppression.js';
import {
  evidenceRowMatches,
  renderCsv,
  clampLimit,
  EVIDENCE_COLUMNS,
  type EvidenceItem,
} from '../src/modules/compliance/evidence.js';

describe('suppression contact normalization', () => {
  it('lower-cases and trims emails', () => {
    expect(normalizeContact('EMAIL', '  Buyer@Acme.IO ')).toBe('buyer@acme.io');
  });

  it('reduces phone numbers to digits only', () => {
    expect(normalizeContact('WHATSAPP', '+1 (555) 123-4567')).toBe('15551234567');
  });

  it('trims trailing slashes from profile URLs', () => {
    expect(normalizeContact('LINKEDIN', 'https://www.linkedin.com/in/jane-doe///')).toBe(
      'https://www.linkedin.com/in/jane-doe',
    );
  });
});

describe('findSuppressionMatch', () => {
  const entries = [
    { channel: 'EMAIL' as const, contact: 'buyer@acme.io' },
    { channel: 'WHATSAPP' as const, contact: '8613800000001' },
    { channel: 'LINKEDIN' as const, contact: 'https://www.linkedin.com/in/jane' },
  ];

  it('matches an exact normalized contact', () => {
    expect(findSuppressionMatch(entries, 'EMAIL', ' BUYER@Acme.IO ')).toBe(entries[0]);
  });

  it('matches WhatsApp numbers by last-9 digit suffix across country-code formats', () => {
    // Registry stores the full E.164; outbound has no country code.
    expect(findSuppressionMatch(entries, 'WHATSAPP', '13800000001')?.contact).toBe('8613800000001');
    // And the reverse: registry short, outbound full.
    const short = [{ channel: 'WHATSAPP' as const, contact: '13800000001' }];
    expect(findSuppressionMatch(short, 'WHATSAPP', '+86 138 0000 0001')).toBe(short[0]);
  });

  it('does not match a different number sharing a short prefix', () => {
    const other = [{ channel: 'WHATSAPP' as const, contact: '8613800000002' }];
    expect(findSuppressionMatch(other, 'WHATSAPP', '13800000001')).toBeNull();
  });

  it('respects channel separation', () => {
    expect(findSuppressionMatch(entries, 'LINKEDIN', 'buyer@acme.io')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(findSuppressionMatch(entries, 'EMAIL', '   ')).toBeNull();
  });
});

describe('evidence row matching', () => {
  it('filters by channel and normalized contact', () => {
    expect(
      evidenceRowMatches({ channel: 'EMAIL', contact: 'Buyer@Acme.IO' }, { channel: 'EMAIL', contact: 'buyer@acme.io' }),
    ).toBe(true);
    expect(
      evidenceRowMatches({ channel: 'EMAIL', contact: 'other@x.io' }, { channel: 'EMAIL', contact: 'buyer@acme.io' }),
    ).toBe(false);
    expect(
      evidenceRowMatches({ channel: 'EMAIL', contact: 'buyer@acme.io' }, { channel: 'WHATSAPP', contact: 'buyer@acme.io' }),
    ).toBe(false);
  });

  it('matches loosely (substring) when no channel filter is set', () => {
    expect(
      evidenceRowMatches({ channel: 'EMAIL', contact: 'ana@acme.io' }, { contact: 'ANA@acme' }),
    ).toBe(true);
  });

  it('matches WhatsApp phones by digit suffix when no channel filter is set', () => {
    expect(
      evidenceRowMatches({ channel: 'WHATSAPP', contact: '+8613800000001' }, { contact: '13800000001' }),
    ).toBe(true);
  });
});

describe('evidence CSV', () => {
  const sample: EvidenceItem[] = [
    {
      ts: '2026-09-09T03:00:00.000Z',
      kind: 'SUPPRESSION',
      channel: 'EMAIL',
      contact: 'buyer@acme.io',
      status: 'UNSUBSCRIBED',
      detail: 'note with, comma and "quotes"\nnewline',
    },
    {
      ts: '2026-09-09T03:01:00.000Z',
      kind: 'SENT',
      channel: 'EMAIL',
      contact: 'buyer@acme.io',
      accountId: 'acc_1',
      refId: 'job_1',
      status: 'SENT',
      detail: null,
    },
  ];

  it('emits the header plus one row per item', () => {
    const csv = renderCsv(sample);
    expect(csv.split('\n')[0]).toBe(EVIDENCE_COLUMNS.join(','));
    expect(csv).toContain('SUPPRESSION');
    expect(csv).toContain('SENT');
  });

  it('quotes fields containing commas, quotes or newlines', () => {
    const csv = renderCsv(sample);
    expect(csv).toContain('"note with, comma and ""quotes""\nnewline"');
    expect(csv).not.toContain('\r');
  });

  it('clamps the row cap', () => {
    expect(clampLimit(undefined)).toBe(500);
    expect(clampLimit(0)).toBe(500);
    expect(clampLimit(12)).toBe(12);
    expect(clampLimit(999999)).toBe(5000);
  });
});
