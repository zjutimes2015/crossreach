// ── Plan definitions (对标 Revor pricing tiers) ─────────────────────────────
// Each plan defines the monthly credit grant, max prospect-list size, and
// connected-channel limits. These mirror Revor's Free / Starter / Scale / Pro
// tiers and are the single source of truth for tier enforcement.

import type { Plan } from '@prisma/client';

export interface PlanDefinition {
  plan: Plan;
  label: string;
  monthlyCredits: number;
  // Monthly subscription price in USD cents (null = custom quote)
  monthlyPriceCents: number | null;
  // Allowed prospect-list sizes (Revor never silently reduces a request)
  allowedListSizes: number[];
  // Max connected email inboxes
  emailInboxes: number;
  // Max connected social channels (LinkedIn / WhatsApp)
  socialChannels: number;
  // Per-credit cost in USD for top-ups (0 = free plan, no top-up)
  effectiveCostPerLead: string;
}

export const PLANS: Record<Plan, PlanDefinition> = {
  STARTER: {
    plan: 'STARTER',
    label: 'Starter',
    monthlyCredits: 5000,
    monthlyPriceCents: 4900,
    allowedListSizes: [25, 100],
    emailInboxes: 1,
    socialChannels: 0,
    effectiveCostPerLead: '~$0.06',
  },
  GROWTH: {
    plan: 'GROWTH',
    label: 'Scale',
    monthlyCredits: 12000,
    monthlyPriceCents: 9900,
    allowedListSizes: [25, 100, 500],
    emailInboxes: 2,
    socialChannels: 1,
    effectiveCostPerLead: '~$0.05',
  },
  PRO: {
    plan: 'PRO',
    label: 'Pro',
    monthlyCredits: 30000,
    monthlyPriceCents: 19900,
    allowedListSizes: [25, 100, 500, 1000],
    emailInboxes: 3,
    socialChannels: 2,
    effectiveCostPerLead: '~$0.04',
  },
  ENTERPRISE: {
    plan: 'ENTERPRISE',
    label: 'Enterprise',
    monthlyCredits: 100000,
    monthlyPriceCents: null,
    allowedListSizes: [25, 100, 500, 1000],
    emailInboxes: 99,
    socialChannels: 99,
    effectiveCostPerLead: 'custom',
  },
};

// Free plan is special — it maps to a STARTER tenant with 0 purchased + a
// reduced grant, surfaced as "Free" on the landing page / billing API.
export const FREE_PLAN: PlanDefinition = {
  plan: 'STARTER',
  label: 'Free',
  monthlyCredits: 300,
  monthlyPriceCents: 0,
  allowedListSizes: [25],
  emailInboxes: 0,
  socialChannels: 0,
  effectiveCostPerLead: '—',
};

// ── Credit costs per resource (metering rates) ──────────────────────────────
// One credit ≈ one discovered prospect or one outbound send. Research and AI
// generation are cheaper because they don't deliver a verified contact.

export const CREDIT_COSTS = {
  WEBSET_ITEM: 1,    // per discovered prospect stored in a webset
  OUTREACH_SEND: 1,  // per email / whatsapp / linkedin outbound send
  RESEARCH: 3,      // per public-web research query batch
  CONTACT_FIND: 2,   // per decision-maker contact lookup by domain
  AI_GENERATE: 1,    // per AI content generation call
} as const;

// ── Billing cycle helpers ───────────────────────────────────────────────────

/** Returns the UTC midnight on the 1st of the month containing `date`. */
export function cycleStartOfMonth(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Returns the UTC midnight on the 1st of the month AFTER `date`. */
export function cycleEndOfMonth(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

/** True if `cycleStartedAt` belongs to a previous month than `date`'s month. */
export function isCycleStale(cycleStartedAt: Date, date: Date = new Date()): boolean {
  return cycleStartedAt < cycleStartOfMonth(date);
}
