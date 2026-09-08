// Plan & pricing invariants — single source of truth for tier enforcement.
import { describe, expect, it } from 'vitest';
import {
  PLANS,
  FREE_PLAN,
  CREDIT_COSTS,
  cycleStartOfMonth,
  cycleEndOfMonth,
  isCycleStale,
} from '../src/modules/billing/plans.js';

describe('PLANS', () => {
  it('covers every plan tier with a definition', () => {
    const keys = Object.keys(PLANS);
    expect(keys.sort()).toEqual(['ENTERPRISE', 'GROWTH', 'PRO', 'STARTER']);
  });

  it('every paid plan has positive monthly credits and a USD price in cents', () => {
    for (const key of Object.keys(PLANS)) {
      const plan = PLANS[key as keyof typeof PLANS];
      expect(plan.monthlyCredits, `${key} monthlyCredits`).toBeGreaterThan(0);
      if (key !== 'ENTERPRISE') {
        expect(plan.monthlyPriceCents, `${key} price`).toBeGreaterThan(0);
        expect(plan.label.length).toBeGreaterThan(0);
      } else {
        expect(plan.monthlyPriceCents).toBeNull();
      }
    }
  });

  it('quotas never allow a higher social allowance to shrink at lower tiers inconsistently', () => {
    // STARTER has no social channel, GROWTH 1, PRO 2, ENTERPRISE unlimited.
    const tier = (key: string) => PLANS[key as keyof typeof PLANS];
    expect(tier('STARTER').socialChannels).toBe(0);
    expect(tier('STARTER').emailInboxes).toBe(1);
    expect(tier('GROWTH').socialChannels).toBe(1);
    expect(tier('GROWTH').emailInboxes).toBe(2);
    expect(tier('PRO').socialChannels).toBe(2);
    expect(tier('PRO').emailInboxes).toBe(3);
    expect(tier('ENTERPRISE').socialChannels).toBe(99);
    expect(tier('ENTERPRISE').emailInboxes).toBe(99);
  });

  it('free plan maps onto the STARTER tier with a reduced grant', () => {
    expect(FREE_PLAN.plan).toBe('STARTER');
    expect(FREE_PLAN.label).toBe('Free');
    expect(FREE_PLAN.monthlyPriceCents).toBe(0);
    expect(FREE_PLAN.monthlyCredits).toBeLessThan(PLANS.STARTER.monthlyCredits);
  });
});

describe('CREDIT_COSTS', () => {
  it('defines a positive cost for every metered resource', () => {
    for (const [resource, cost] of Object.entries(CREDIT_COSTS)) {
      expect(cost, resource).toBeGreaterThan(0);
    }
    expect(CREDIT_COSTS.WEBSET_ITEM).toBe(1);
    expect(CREDIT_COSTS.OUTREACH_SEND).toBe(1);
  });
});

describe('billing cycle helpers', () => {
  it('computes UTC month boundaries for the credit grant', () => {
    const within = new Date('2026-06-15T12:00:00Z');
    expect(cycleStartOfMonth(within).toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(cycleEndOfMonth(within).toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('detects stale grant cycles across month boundaries', () => {
    const current = new Date('2026-06-10T00:00:00Z');
    expect(isCycleStale(new Date('2026-05-31T00:00:00Z'), current)).toBe(true);
    expect(isCycleStale(new Date('2026-06-01T00:00:00Z'), current)).toBe(false);
  });
});
