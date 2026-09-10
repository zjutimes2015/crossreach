// ── Creem billing integration ────────────────────────────────────────────────
// Runs alongside Stripe as a second PSP. Creem carries the FIXED credit packs
// (充值包): one-time Checkout for a product whose credits are defined in env.
// Stripe keeps arbitrary-amount top-ups and monthly subscriptions.
//
// Flow:
//   1. GET  /v1/billing/creem/packs    → packs defined by CREEM_TOPUP_PACKS
//   2. POST /v1/billing/creem/checkout → create a Creem Checkout session
//      body: { productId, successUrl } → { checkoutId, url }
//   3. Customer pays on checkout.creem.io; Creem POSTs /webhooks/creem
//   4. Webhook verifies `creem-signature` (HMAC-SHA256 of the raw body with the
//      webhook secret) then reconciles the order into the tenant's purchased
//      credits. Creem redelivers events (retry + manual resend), so the
//      reconciliation is idempotent on the Creem order id.
//
// Tenant identity rides in the checkout metadata.tenantId (echoed back on the
// webhook object). Secrets are read lazily from process.env so tests can point
// CREEM_BASE_URL at a fake server after import:
//   CREEM_API_KEY / CREEM_WEBHOOK_SECRET / CREEM_BASE_URL / CREEM_TOPUP_PACKS

import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import { ensureBalance } from './balance.js';

export const CREEM_PROVIDER = 'CREEM';

// One fixed pack = one Creem product that grants a fixed credit amount.
export interface CreemPack {
  productId: string;
  credits: number;
  label: string;
  /** USD cents the merchant charges on the Creem product (display only). */
  priceCents?: number;
}

// ── Configuration (lazy env reads — mirrors the Stripe module) ──────────────

function creemApiKey(): string | undefined {
  return process.env.CREEM_API_KEY?.trim() || undefined;
}

export function creemWebhookSecret(): string | undefined {
  return process.env.CREEM_WEBHOOK_SECRET?.trim() || undefined;
}

/** Base URL without trailing slash. Test mode defaults to test-api.creem.io. */
function creemBaseUrl(): string {
  const explicit = process.env.CREEM_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return process.env.NODE_ENV === 'production'
    ? 'https://api.creem.io'
    : 'https://test-api.creem.io';
}

/**
 * Packs are configured as a JSON array in CREEM_TOPUP_PACKS, e.g.
 *   [{"productId":"prod_xxx","credits":10000,"label":"10,000 credits","priceCents":500}]
 * An unset/empty/invalid value disables the Creem checkout surface entirely.
 */
export function getCreemPacks(): CreemPack[] {
  const raw = process.env.CREEM_TOPUP_PACKS?.trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is Record<string, unknown> =>
          !!p && typeof p === 'object' && typeof p.productId === 'string' && !!p.productId &&
          Number.isFinite(Number(p.credits)) && Number(p.credits) > 0,
      )
      .map((p) => {
        const credits = Math.round(Number(p.credits));
        return {
          productId: p.productId as string,
          credits,
          label:
            typeof p.label === 'string' && (p.label as string).trim()
              ? (p.label as string)
              : `${credits.toLocaleString()} credits`,
          ...(Number.isFinite(Number(p.priceCents)) && Number(p.priceCents) >= 0
            ? { priceCents: Math.round(Number(p.priceCents)) }
            : {}),
        };
      });
  } catch (err) {
    logger.warn({ err, raw }, 'Invalid CREEM_TOPUP_PACKS JSON — Creem packs disabled');
    return [];
  }
}

function findPack(productId: string): CreemPack | undefined {
  return getCreemPacks().find((p) => p.productId === productId);
}

/** True when the operator configured a key AND at least one credit pack. */
export function creemConfigured(): boolean {
  return !!creemApiKey() && getCreemPacks().length > 0;
}

// ── Checkout session creation ───────────────────────────────────────────────

export interface CreemCheckoutInput {
  productId: string;
  successUrl: string;
}

export async function createCreemCheckout(
  tenantId: string,
  input: CreemCheckoutInput,
): Promise<{ checkoutId: string; url: string }> {
  const apiKey = creemApiKey();
  if (!apiKey) throw new Error('CREEM_API_KEY is not configured');
  if (!input.successUrl) throw new Error('successUrl is required');
  const pack = findPack(input.productId);
  if (!pack) throw new Error('Unknown Creem product — no matching top-up pack configured');

  // Pre-fill the account owner's email so Creem can attribute the customer.
  const owner = await prisma.user.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    select: { email: true },
  });

  const body: Record<string, unknown> = {
    product_id: pack.productId,
    success_url: input.successUrl,
    request_id: `crossreach-${tenantId}-${Date.now()}`,
    // tenantId + credits are echoed back in the webhook object.metadata —
    // the credits are the source of truth for reconciliation even if the env
    // pack mapping changes between checkout and webhook delivery.
    metadata: { tenantId, source: 'crossreach', credits: pack.credits, pack: pack.productId },
  };
  if (owner?.email) body.customer = { email: owner.email };

  const res = await fetch(`${creemBaseUrl()}/v1/checkouts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    checkout_url?: string;
    error?: unknown;
  };

  if (!res.ok || !json.checkout_url) {
    const detail =
      typeof json.error === 'string' ? json.error : JSON.stringify(json.error ?? json);
    throw new Error(`Creem checkout failed (${res.status}) — ${detail}`);
  }

  logger.info(
    { tenantId, productId: pack.productId, credits: pack.credits, checkoutId: json.id },
    'Creem checkout session created',
  );
  return { checkoutId: json.id ?? '', url: json.checkout_url };
}

// ── Webhook handling ────────────────────────────────────────────────────────

/**
 * Creem signs the raw request body with HMAC-SHA256 using the webhook secret;
 * the header `creem-signature` carries the hex digest. Compare in constant time.
 */
export function verifyCreemSignature(
  rawBody: string,
  signature: string,
  secret: string | undefined = creemWebhookSecret(),
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface CreemWebhookEvent {
  id?: string;
  eventType?: string;
  object?: {
    id?: string;
    status?: string;
    metadata?: Record<string, unknown> | null;
    order?: { id?: string; amount?: number; currency?: string; status?: string } | null;
    product?: { id?: string; name?: string; price?: number; currency?: string; billing_type?: string } | null;
    subscription?: { id?: string; status?: string } | null;
  } | null;
}

export interface CreemWebhookResult {
  handled: boolean;
  eventType?: string;
}

export async function handleCreemWebhook(
  rawBody: string,
  signature: string,
): Promise<CreemWebhookResult> {
  if (!verifyCreemSignature(rawBody, signature)) {
    throw new Error('Creem webhook signature verification failed');
  }

  let event: CreemWebhookEvent;
  try {
    event = JSON.parse(rawBody) as CreemWebhookEvent;
  } catch (err) {
    throw new Error('Invalid Creem webhook payload — not JSON');
  }

  if (event.eventType !== 'checkout.completed') {
    logger.info({ eventType: event.eventType }, 'Unhandled Creem event');
    return { handled: false, eventType: event.eventType };
  }

  await reconcileCreemCheckout(event);
  return { handled: true, eventType: event.eventType };
}

/**
 * Credit the tenant's purchased pool for a completed one-time checkout.
 * Idempotent on the Creem order id: redelivered webhooks (Creem retries up to
 * 5× with backoff and allows manual resends) are acknowledged and skipped.
 */
async function reconcileCreemCheckout(event: CreemWebhookEvent): Promise<void> {
  const object = event.object;
  const tenantId =
    object?.metadata && typeof object.metadata.tenantId === 'string'
      ? object.metadata.tenantId
      : null;
  const orderId = object?.order?.id ?? object?.id ?? event.id;

  if (!tenantId) {
    logger.warn({ eventId: event.id, orderId }, 'Creem webhook: no tenant reference');
    return;
  }

  // Creem only carries one-time credit packs here; recurring products (which we
  // never create via Creem — subscriptions stay on Stripe) are ignored.
  if (object?.subscription || object?.product?.billing_type === 'recurring') {
    logger.info(
      { tenantId, orderId, productId: object?.product?.id },
      'Creem recurring checkout ignored',
    );
    return;
  }

  // Credits come from the metadata written at checkout time; fall back to the
  // env pack mapping if metadata is missing (e.g. dashboard-created sessions).
  let credits = Number(object?.metadata?.credits);
  if (!Number.isFinite(credits) || credits <= 0) {
    credits = findPack(object?.product?.id ?? '')?.credits ?? 0;
  }
  if (credits <= 0) {
    logger.warn({ tenantId, orderId, productId: object?.product?.id }, 'Creem checkout: no credits to credit');
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  if (!tenant) {
    logger.warn({ tenantId, orderId }, 'Creem webhook references an unknown tenant');
    return;
  }

  const amount = Number(object?.order?.amount) || 0;
  const currency = (object?.order?.currency ?? object?.product?.currency ?? 'usd').toLowerCase();
  const success = object?.order?.status === 'paid' || object?.status === 'completed';

  await ensureBalance(tenantId, tenant.plan);

  const outcome = await prisma.$transaction(async (tx) => {
    // Redelivery guard inside the transaction (findFirst above could race).
    const dup = await tx.paymentEvent.findFirst({
      where: { provider: CREEM_PROVIDER, providerEventId: orderId },
    });
    if (dup) return { duplicated: true as const };

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
        description: `Creem top-up — ${credits.toLocaleString()} credits`,
        metadata: {
          checkoutId: object?.id,
          orderId,
          productId: object?.product?.id,
        } as object,
      },
    });
    await tx.paymentEvent.create({
      data: {
        tenantId,
        provider: CREEM_PROVIDER,
        providerEventId: orderId,
        eventKind: 'CHECKOUT_COMPLETE',
        amount,
        currency,
        success,
        metadata: {
          eventId: event.id,
          checkoutId: object?.id,
          orderId,
          productId: object?.product?.id,
          credits,
        } as object,
      },
    });
    return { duplicated: false as const };
  });

  if (outcome.duplicated) {
    logger.info({ tenantId, orderId }, 'Creem webhook already reconciled — skipped (idempotent)');
  } else {
    logger.info({ tenantId, credits, orderId }, 'Creem top-up reconciled');
  }
}
