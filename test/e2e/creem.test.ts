// E2E: Creem billing chain — second PSP for fixed credit packs (充值包).
// Real server + real DB. Proves that:
//   • GET /v1/billing/creem/packs exposes only the env-configured packs
//   • POST /v1/billing/creem/checkout creates a Creem Checkout and returns the
//     redirect url, carrying x-api-key + metadata.tenantId upstream
//   • POST /webhooks/creem verifies `creem-signature` (HMAC-SHA256 raw body)
//     and credits the tenant's purchased balance from object.metadata.credits
//   • redelivered webhooks are idempotent (no double credit) and an invalid
//     signature is rejected
//
// Env must be configured BEFORE importing src (config/prisma read env at load).
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  E2E_API_KEY,
  applyE2EEnv,
  resetDatabase,
  bootApp,
} from './helpers.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

// ── Fake Creem API ───────────────────────────────────────────────────────────
// Faithful at the HTTP level for the two calls CrossReach makes:
//   POST /v1/checkouts → { id, checkout_url, product_id, status }
// Captures the request so tests can assert what the app actually sent.
const CREEM_SECRET = 'e2e-creem-webhook-secret';
const PACK = { productId: 'prod_e2e_10k', credits: 10000, label: '10,000 credits', priceCents: 500 };

let creemRequests: Array<{ path: string; apiKey: string | undefined; body: any }> = [];
let creemServer: Server;
let creemUrl = '';

async function startFakeCreemServer(): Promise<void> {
  creemServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      creemRequests.push({
        path: req.url ?? '',
        apiKey: req.headers['x-api-key'] as string | undefined,
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && /\/v1\/checkouts$/.test(req.url ?? '')) {
        const productId = JSON.parse(raw)?.product_id ?? 'prod_unknown';
        res.end(
          JSON.stringify({
            id: 'ch_e2e_checkout',
            checkout_url: `https://checkout.creem.test/ch_e2e_checkout`,
            product_id: productId,
            status: 'pending',
          }),
        );
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });
  await new Promise<void>((resolve) => creemServer.listen(0, '127.0.0.1', resolve));
  creemUrl = `http://127.0.0.1:${(creemServer.address() as AddressInfo).port}`;
}

await startFakeCreemServer();
applyE2EEnv('http://127.0.0.1:1'); // graph base never used here
process.env.CREEM_API_KEY = 'cr_e2e_api_key';
process.env.CREEM_WEBHOOK_SECRET = CREEM_SECRET;
process.env.CREEM_BASE_URL = creemUrl;
process.env.CREEM_TOPUP_PACKS = JSON.stringify([PACK]);

const { prisma } = await import('../../src/db/prisma.js');

let app: FastifyInstance;
let baseUrl: string;
let tenantId: string;

const authHeaders = { 'x-api-key': E2E_API_KEY, 'content-type': 'application/json' };

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function postJson(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function signCreemBody(rawBody: string): string {
  return createHmac('sha256', CREEM_SECRET).update(rawBody).digest('hex');
}

function checkoutCompletedEvent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'evt_e2e_1',
    eventType: 'checkout.completed',
    created_at: Date.now(),
    object: {
      id: 'ch_e2e_1',
      status: 'completed',
      metadata: { tenantId, source: 'crossreach', credits: PACK.credits, pack: PACK.productId },
      order: { id: 'ord_e2e_1', amount: PACK.priceCents, currency: 'usd', status: 'paid' },
      product: {
        id: PACK.productId,
        name: PACK.label,
        price: PACK.priceCents,
        currency: 'usd',
        billing_type: 'one_time',
      },
    },
    ...overrides,
  });
}

async function postCreemWebhook(rawBody: string, signature: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/webhooks/creem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'creem-signature': signature },
    body: rawBody,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe('E2E Creem billing chain', () => {
  beforeAll(async () => {
    await resetDatabase(prisma);
    const booted = await bootApp();
    app = booted.app;
    baseUrl = booted.baseUrl;
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => creemServer.close(() => resolve()));
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    creemRequests = [];
    const tenant = await prisma.tenant.create({
      data: {
        name: 'E2E Creem Co.',
        plan: 'GROWTH',
        status: 'ACTIVE',
        apiKey: E2E_API_KEY,
      },
    });
    tenantId = tenant.id;
  });

  it('lists only the env-configured Creem packs', async () => {
    const { status, body } = await getJson('/api/v1/billing/creem/packs');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.packs).toEqual([PACK]);
  });

  it('creates a Creem checkout with the tenant reference upstream', async () => {
    const { status, body } = await postJson('/api/v1/billing/creem/checkout', {
      productId: PACK.productId,
      successUrl: 'http://localhost:5173/dashboard/billing?paid=creem',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toBe('https://checkout.creem.test/ch_e2e_checkout');

    expect(creemRequests).toHaveLength(1);
    const call = creemRequests[0];
    expect(call.path).toBe('/v1/checkouts');
    expect(call.apiKey).toBe('cr_e2e_api_key');
    expect(call.body.product_id).toBe(PACK.productId);
    expect(call.body.success_url).toContain('paid=creem');
    expect(call.body.metadata.tenantId).toBe(tenantId);
    expect(call.body.metadata.credits).toBe(PACK.credits);
    expect(typeof call.body.request_id).toBe('string');
  });

  it('rejects checkout for an unknown product id', async () => {
    const { status, body } = await postJson('/api/v1/billing/creem/checkout', {
      productId: 'prod_does_not_exist',
      successUrl: 'http://localhost:5173/dashboard/billing',
    });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(String(body.error.code)).toContain('Unknown Creem product');
  });

  it('reconciles a signed checkout.completed webhook into purchased credits', async () => {
    const rawBody = checkoutCompletedEvent();
    const { status, body } = await postCreemWebhook(rawBody, signCreemBody(rawBody));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const bal = await getJson('/api/v1/billing/balance');
    expect(bal.body.balance.purchased).toBe(PACK.credits);
    expect(bal.body.balance.available).toBeGreaterThanOrEqual(PACK.credits);

    const ev = await prisma.paymentEvent.findFirst({
      where: { tenantId, provider: 'CREEM' },
    });
    expect(ev).not.toBeNull();
    expect(ev!.providerEventId).toBe('ord_e2e_1');
    expect(ev!.success).toBe(true);
    expect(ev!.amount).toBe(PACK.priceCents);

    const txn = await prisma.creditTransaction.findFirst({
      where: { tenantId, type: 'TOP_UP' },
    });
    expect(txn!.amount).toBe(PACK.credits);
  });

  it('is idempotent across webhook redelivery', async () => {
    const rawBody = checkoutCompletedEvent();
    const sig = signCreemBody(rawBody);

    const first = await postCreemWebhook(rawBody, sig);
    expect(first.status).toBe(200);
    const afterFirst = await getJson('/api/v1/billing/balance');
    expect(afterFirst.body.balance.purchased).toBe(PACK.credits);

    const second = await postCreemWebhook(rawBody, sig);
    expect(second.status).toBe(200);
    const afterSecond = await getJson('/api/v1/billing/balance');
    expect(afterSecond.body.balance.purchased).toBe(PACK.credits);

    const count = await prisma.paymentEvent.count({ where: { tenantId, provider: 'CREEM' } });
    expect(count).toBe(1);
  });

  it('rejects a webhook with an invalid or missing signature', async () => {
    const rawBody = checkoutCompletedEvent();
    const badSig = await postCreemWebhook(rawBody, 'deadbeef');
    expect(badSig.status).toBe(400);

    const res = await fetch(`${baseUrl}/webhooks/creem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });
    expect(res.status).toBe(400);

    const bal = await getJson('/api/v1/billing/balance');
    expect(bal.body.balance.purchased).toBe(0);
  });
});
