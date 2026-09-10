// Creem billing integration — pack config parsing, checkout request building
// and webhook signature verification. Pure logic only (no DB / network).
import { describe, expect, it, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  getCreemPacks,
  creemConfigured,
  verifyCreemSignature,
  CREEM_PROVIDER,
} from '../src/modules/billing/creem.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getCreemPacks', () => {
  it('parses a JSON array of packs into typed pack objects', () => {
    process.env.CREEM_TOPUP_PACKS = JSON.stringify([
      { productId: 'prod_10k', credits: 10000, label: '10,000 credits', priceCents: 500 },
      { productId: 'prod_50k', credits: 50000 },
    ]);
    const packs = getCreemPacks();
    expect(packs).toHaveLength(2);
    expect(packs[0]).toEqual({
      productId: 'prod_10k',
      credits: 10000,
      label: '10,000 credits',
      priceCents: 500,
    });
    // No priceCents → default label derived from credits.
    expect(packs[1]).toEqual({
      productId: 'prod_50k',
      credits: 50000,
      label: '50,000 credits',
    });
  });

  it('drops invalid entries (missing productId, non-positive credits)', () => {
    process.env.CREEM_TOPUP_PACKS = JSON.stringify([
      { productId: 'prod_a', credits: 1000 },
      { credits: 1000 },
      { productId: 'prod_b', credits: 0 },
      'garbage',
    ]);
    const packs = getCreemPacks();
    expect(packs).toHaveLength(1);
    expect(packs[0].productId).toBe('prod_a');
  });

  it('returns [] when unset, empty, non-array or malformed JSON', () => {
    delete process.env.CREEM_TOPUP_PACKS;
    expect(getCreemPacks()).toEqual([]);
    process.env.CREEM_TOPUP_PACKS = '';
    expect(getCreemPacks()).toEqual([]);
    process.env.CREEM_TOPUP_PACKS = '{"not":"an array"}';
    expect(getCreemPacks()).toEqual([]);
    process.env.CREEM_TOPUP_PACKS = 'not json {';
    expect(getCreemPacks()).toEqual([]);
  });
});

describe('creemConfigured', () => {
  it('is true only when a key AND at least one pack are configured', () => {
    process.env.CREEM_TOPUP_PACKS = JSON.stringify([{ productId: 'prod_a', credits: 1000 }]);
    process.env.CREEM_API_KEY = 'cr_test_key';
    expect(creemConfigured()).toBe(true);

    delete process.env.CREEM_API_KEY;
    expect(creemConfigured()).toBe(false);

    process.env.CREEM_API_KEY = 'cr_test_key';
    process.env.CREEM_TOPUP_PACKS = '';
    expect(creemConfigured()).toBe(false);
  });
});

describe('verifyCreemSignature', () => {
  const SECRET = 'whsec_creem_test';
  const body = JSON.stringify({ id: 'evt_1', eventType: 'checkout.completed', object: {} });

  it('accepts a valid HMAC-SHA256 hex signature of the raw body', () => {
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyCreemSignature(body, sig, SECRET)).toBe(true);
  });

  it('rejects a tampered body / wrong secret / empty signature', () => {
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyCreemSignature(body + ' ', sig, SECRET)).toBe(false);
    expect(verifyCreemSignature(body, sig, 'whsec_wrong')).toBe(false);
    expect(verifyCreemSignature(body, '', SECRET)).toBe(false);
    expect(verifyCreemSignature(body, sig, undefined)).toBe(false);
  });

  it('reads the secret from env when not passed explicitly', () => {
    process.env.CREEM_WEBHOOK_SECRET = SECRET;
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyCreemSignature(body, sig)).toBe(true);
    delete process.env.CREEM_WEBHOOK_SECRET;
    expect(verifyCreemSignature(body, sig)).toBe(false);
  });
});

describe('CREEM_PROVIDER', () => {
  it('is the stable provider tag used in payment_events', () => {
    expect(CREEM_PROVIDER).toBe('CREEM');
  });
});
