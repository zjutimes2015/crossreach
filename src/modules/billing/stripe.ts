// ── Stripe billing integration ───────────────────────────────────────────────
// Connects CrossReach's credit system to Stripe Checkout + webhook handling.
//
// Flow:
//   1. POST /v1/billing/stripe/checkout  → create a Checkout Session
//      - { planId }            → Stripe Subscription (recurring monthly)
//      - { creditAmount }      → Stripe Payment (one-off top-up of credits)
//   2. Customer completes Checkout; Stripe POSTs /v1/billing/stripe/webhook
//   3. Webhook handler reconciles:
//      - invoice.paid for a subscription plan → activate plan on tenant
//      - checkout.session.completed top-up    → credit the tenant's balance
//
// Tenant identity rides on the session's client_reference_id (tenant id) so
// no Stripe Customer object is strictly required for one-off top-ups.
//
// Secrets: STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (see config/index.ts).

import Stripe from 'stripe';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import { PLANS } from './plans.js';
import { ensureBalance } from './balance.js';
import type { Plan } from '@prisma/client';

let _stripe: Stripe | undefined;

function stripe(): Stripe {
  if (!_stripe) {
    const sk = process.env.STRIPE_SECRET_KEY;
    if (!sk) throw new Error('STRIPE_SECRET_KEY is not configured');
    _stripe = new Stripe(sk, { apiVersion: '2026-08-26.dahlia' });
  }
  return _stripe;
}

// Credit price: $0.0005 / credit → $5 buys 10,000 credits. Exposed for the
// dashboard to preview top-up cost before redirecting to Checkout.
export const CREDITS_PER_DOLLAR = 10000;

export function creditsToUnitAmount(credits: number): number {
  return Math.round((credits / CREDITS_PER_DOLLAR) * 100); // USD cents
}

export function unitAmountToCredits(unitAmountCents: number): number {
  return Math.round((unitAmountCents / 100) * CREDITS_PER_DOLLAR);
}

export interface CheckoutInput {
  /** One-off credit top-up amount (> 0). Mutually exclusive with planId. */
  creditAmount?: number;
  /** Subscribe the tenant to a monthly plan. Mutually exclusive with creditAmount. */
  planId?: Plan;
  /** Description shown on the Stripe line item (defaults when omitted). */
  description?: string;
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(
  tenantId: string,
  input: CheckoutInput,
): Promise<{ sessionId: string; url: string }> {
  const isTopUp = (input.creditAmount ?? 0) > 0;
  const isSubscription = !!input.planId;
  if (isTopUp === isSubscription) {
    throw new Error('Provide exactly one of creditAmount (top-up) or planId (subscription)');
  }

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: isSubscription ? 'subscription' : 'payment',
    line_items: [],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: tenantId,
    metadata: { tenantId, source: 'crossreach' },
    allow_promotion_codes: true,
  };

  if (isSubscription) {
    const planDef = PLANS[input.planId!];
    if (!planDef.monthlyPriceCents) {
      throw new Error(`Plan ${planDef.label} is custom-quoted; contact sales for checkout`);
    }
    sessionParams.line_items!.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `CrossReach ${planDef.label}`,
          description: `${planDef.monthlyCredits.toLocaleString()} credits / month · list sizes ${planDef.allowedListSizes.join(' / ')}`,
        },
        unit_amount: planDef.monthlyPriceCents,
        recurring: { interval: 'month' },
      },
      quantity: 1,
    });
  } else {
    const credits = Math.max(1, Math.round(input.creditAmount!));
    sessionParams.line_items!.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'CrossReach credits',
          description: input.description ?? `${credits.toLocaleString()} credits — never expire`,
        },
        unit_amount: creditsToUnitAmount(credits),
      },
      quantity: 1,
    });
  }

  const session = await stripe().checkout.sessions.create(sessionParams);
  logger.info({ tenantId, mode: sessionParams.mode, sessionId: session.id }, 'Stripe Checkout session created');
  return { sessionId: session.id, url: session.url! };
}

// ── Webhook handling ────────────────────────────────────────────────────────

export async function handleStripeWebhook(payload: Buffer, signature: string): Promise<void> {
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!endpointSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(payload, signature, endpointSecret);
  } catch (err) {
    logger.warn({ err }, 'Stripe webhook signature verification failed');
    throw err;
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenantId = session.client_reference_id ?? session.metadata?.tenantId;
      if (tenantId) await reconcileCheckout(session, tenantId);
      else logger.warn({ sessionId: session.id }, 'Stripe webhook: no tenant reference');
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      await reconcileSubscriptionInvoice(invoice);
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      await markPaymentFailed(invoice);
      break;
    }
    case 'customer.subscription.deleted':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscriptionState(sub);
      break;
    }
    default:
      logger.info({ type: event.type }, 'Unhandled Stripe event');
  }
}

/** One-off top-up: credit the tenant's purchased pool. */
async function reconcileCheckout(session: Stripe.Checkout.Session, tenantId: string): Promise<void> {
  if (session.mode === 'subscription') return; // handled by invoice.paid

  // Re-fetch line items with expanded price to know what was paid for
  const items = await stripe().checkout.sessions.listLineItems(session.id, { expand: ['data.price'] });
  let credits = 0;
  for (const item of items.data) {
    const product = (item.price?.product as Stripe.Product | string | undefined);
    const productName = typeof product === 'object' ? product?.name : item.description;
    const qty = item.quantity ?? 1;
    const unit = item.price?.unit_amount ?? 0;
    if (/credit/i.test(productName ?? '')) {
      credits += unitAmountToCredits(unit) * qty;
    }
  }

  if (credits <= 0) {
    logger.warn({ sessionId: session.id, tenantId }, 'Checkout completed but no credits detected');
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  if (!tenant) {
    logger.warn({ tenantId }, 'Checkout references an unknown tenant');
    return;
  }
  await ensureBalance(tenantId, tenant.plan);

  const result = await prisma.$transaction(async (tx) => {
    const balance = await tx.creditBalance.findUniqueOrThrow({ where: { tenantId } });
    const updated = await tx.creditBalance.update({
      where: { tenantId },
      data: { purchased: { increment: credits } },
    });
    const balanceAfter = updated.purchased + Math.max(0, balance.granted - balance.consumedThisCycle);
    await tx.creditTransaction.create({
      data: {
        tenantId,
        type: 'TOP_UP',
        amount: credits,
        balanceAfter,
        description: `Stripe top-up — ${credits.toLocaleString()} credits`,
        metadata: { stripeSessionId: session.id } as object,
      },
    });
    await tx.paymentEvent.create({
      data: {
        tenantId,
        provider: 'STRIPE',
        providerEventId: session.id,
        eventKind: 'CHECKOUT_COMPLETE',
        amount: session.amount_total ?? 0,
        currency: session.currency ?? 'usd',
        success: true,
        metadata: { sessionId: session.id, credits } as object,
      },
    });
    return { balanceAfter };
  });

  logger.info({ tenantId, credits, balanceAfter: result.balanceAfter }, 'Stripe top-up reconciled');
}

/** Subscription invoice: activate / keep the plan active on the tenant. */
async function reconcileSubscriptionInvoice(invoice: Stripe.Invoice): Promise<void> {
  // Invoices don't carry client_reference_id; resolve the tenant either from
  // the stored StripeCustomer row (via customer id) or the invoice metadata.
  const tenantId = invoice.metadata?.tenantId;
  if (tenantId) {
    const subId = invoiceSubscriptionId(invoice);
    if (subId) await activatePlanFromSubscription(subId, tenantId);
    return;
  }

  const row = await prisma.stripeCustomer.findFirst({ where: { stripeCustomerId: String(invoice.customer) } });
  if (!row) {
    logger.warn({ invoiceId: invoice.id }, 'Invoice paid but no tenant matched');
    return;
  }
  const subId = invoiceSubscriptionId(invoice);
  if (subId) await activatePlanFromSubscription(subId, row.tenantId);
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // Stripe SDK versions vary on whether Invoice.subscription is inlined.
  const sub = (invoice as unknown as { subscription?: string | null }).subscription;
  return typeof sub === 'string' ? sub : null;
}

async function activatePlanFromSubscription(subscriptionId: string, tenantId: string): Promise<void> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId, { expand: ['items.data.price.product'] });
  const item = sub.items.data[0];
  const product = item?.price?.product as Stripe.Product | string | undefined;
  const productName = typeof product === 'object' ? product?.name : '';
  const planKey = (productName ?? '').replace(/^CrossReach /, '').trim().toUpperCase() as Plan;

  if (!PLANS[planKey]) {
    logger.warn({ productName, tenantId }, 'Subscription product does not map to a plan');
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({
      where: { id: tenantId },
      data: { plan: planKey, status: 'ACTIVE' },
    });
    await tx.stripeCustomer.upsert({
      where: { tenantId },
      create: { tenantId, stripeCustomerId: String(sub.customer), status: sub.status, lastPlanId: planKey },
      update: { stripeCustomerId: String(sub.customer), status: sub.status, lastPlanId: planKey },
    });
    await tx.paymentEvent.create({
      data: {
        tenantId,
        provider: 'STRIPE',
        providerEventId: String(invoiceIdOf(sub)),
        eventKind: 'SUBSCRIPTION_PAID',
        amount: 0,
        success: true,
        metadata: { subscriptionId, plan: planKey } as object,
      },
    });
  });

  logger.info({ tenantId, plan: planKey, subscriptionId }, 'Tenant plan activated via Stripe subscription');
}

// helper kept local to avoid passing the invoice object around
function invoiceIdOf(_sub: Stripe.Subscription): string {
  return _sub.latest_invoice ? String(_sub.latest_invoice) : 'invoice';
}

async function markPaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const row = await prisma.stripeCustomer.findFirst({ where: { stripeCustomerId: String(invoice.customer) } });
  if (!row) return;
  await prisma.stripeCustomer.update({
    where: { tenantId: row.tenantId },
    data: { status: 'past_due' },
  });
  await prisma.paymentEvent.create({
    data: {
      tenantId: row.tenantId,
      provider: 'STRIPE',
      providerEventId: invoice.id,
      eventKind: 'INVOICE_PAID',
      amount: invoice.amount_due ?? 0,
      success: false,
      metadata: { reason: 'payment_failed' } as object,
    },
  });
  logger.warn({ tenantId: row.tenantId, invoiceId: invoice.id }, 'Stripe invoice payment failed');
}

async function syncSubscriptionState(sub: Stripe.Subscription): Promise<void> {
  const row = await prisma.stripeCustomer.findFirst({ where: { stripeCustomerId: String(sub.customer) } });
  if (!row) return;
  const status = sub.status === 'active' || sub.status === 'trialing' ? sub.status : 'cancelled';
  await prisma.stripeCustomer.update({ where: { tenantId: row.tenantId }, data: { status } });
  if (status === 'cancelled') {
    // Downgrade the tenant to STARTER grant but keep purchased credits
    await prisma.tenant.update({ where: { id: row.tenantId }, data: { status: 'TRIAL' } });
    logger.info({ tenantId: row.tenantId }, 'Subscription cancelled — tenant downgraded');
  }
}
