// Contract-level E2E: boots the REAL Fastify server + real Postgres against a
// LOCAL fake WhatsApp Graph API, and drives the product's critical paths over
// real HTTP with real HMAC signatures. This proves the wiring end-to-end:
//   auth gate → webhook HMAC verify → inbound message → customer/conversation/
//   message rows + stop-if-replied → sequence dispatch → outbound Graph POST.
//
// Env must be configured BEFORE importing src (config/prisma read env at load).
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  E2E_API_KEY,
  E2E_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  applyE2EEnv,
  startFakeGraphServer,
  signMetaBody,
  resetDatabase,
  bootApp,
  waitFor,
  post,
} from './helpers.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

// ── Boot order matters: fake upstream first, then env, then src imports ────
const graph = await startFakeGraphServer();
applyE2EEnv(graph.url);

const { prisma } = await import('../../src/db/prisma.js');
const {
  createSequence,
  enrollInSequence,
  processDueSteps,
} = await import('../../src/modules/growth/sequences.js');

let app: FastifyInstance;
let baseUrl: string;
let tenantId: string;

function inboundRawBody(phone: string, text: string, msgId: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '0',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550000000',
                phone_number_id: E2E_PHONE_NUMBER_ID,
              },
              contacts: [{ profile: { name: 'Li Wei' }, wa_id: phone }],
              messages: [
                {
                  from: phone,
                  id: msgId,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe('E2E critical path', () => {
  beforeAll(async () => {
    await resetDatabase(prisma);
    const booted = await bootApp();
    app = booted.app;
    baseUrl = booted.baseUrl;
  });

  afterAll(async () => {
    await app.close();
    await graph.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const tenant = await prisma.tenant.create({
      data: {
        name: 'E2E Co.',
        plan: 'GROWTH',
        status: 'ACTIVE',
        apiKey: E2E_API_KEY,
      },
    });
    tenantId = tenant.id;
    await prisma.channel.create({
      data: {
        tenantId,
        type: 'WHATSAPP',
        name: 'E2E WhatsApp',
        isActive: true,
        config: {
          phoneNumberId: E2E_PHONE_NUMBER_ID,
          accessToken: 'e2e-access-token',
          verifyToken: WHATSAPP_VERIFY_TOKEN,
          apiVersion: 'v18.0',
        },
      },
    });
  });

  // ── Auth gate ────────────────────────────────────────────────────────────
  it('rejects API calls without a valid tenant key', async () => {
    const noKey = await fetch(`${baseUrl}/api/v1/billing/plan`);
    expect(noKey.status).toBe(401);

    const badKey = await fetch(`${baseUrl}/api/v1/billing/plan`, {
      headers: { 'x-api-key': 'nope' },
    });
    expect(badKey.status).toBe(401);
  });

  it('serves the plan for a valid key and refuses a suspended tenant', async () => {
    const res = await fetch(`${baseUrl}/api/v1/billing/plan`, {
      headers: { 'x-api-key': E2E_API_KEY },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { plan: { name: string; monthlyCredits: number } };
    expect(data.plan.name).toBe('GROWTH');
    expect(data.plan.monthlyCredits).toBeGreaterThan(0);

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { status: 'SUSPENDED' },
    });
    const suspended = await fetch(`${baseUrl}/api/v1/billing/plan`, {
      headers: { 'x-api-key': E2E_API_KEY },
    });
    expect(suspended.status).toBe(401);
  });

  // ── WhatsApp subscription handshake ──────────────────────────────────────
  it('completes the WhatsApp webhook verification handshake', async () => {
    const ok = await fetch(
      `${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${WHATSAPP_VERIFY_TOKEN}&hub.challenge=CHALLENGE_123`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('CHALLENGE_123');

    const bad = await fetch(
      `${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`,
    );
    expect(bad.status).toBe(403);
  });

  // ── Inbound WhatsApp message (signed) → full CDP pipeline ───────────────
  it('processes a signed inbound message, stops the running sequence', async () => {
    const phone = '+8613800000001';

    // Seed a customer already enrolled in an active follow-up sequence.
    const customer = await prisma.customer.create({
      data: { tenantId, externalId: phone, name: 'Li Wei', phone, source: 'whatsapp' },
    });
    const sequence = await createSequence({
      tenantId,
      name: 'Follow-up',
      channelId: (await prisma.channel.findFirstOrThrow({ where: { tenantId } })).id,
      steps: [{ stepNumber: 1, delayMinutes: 60, actionType: 'SEND_TEMPLATE', templateName: 'follow_up' }],
    });
    await enrollInSequence(tenantId, sequence.id, customer.id);

    const raw = inboundRawBody(phone, 'I am interested, let us talk.', 'wamid.inbound.1');
    const res = await post(`${baseUrl}/webhooks/whatsapp`, raw, {
      'x-hub-signature-256': signMetaBody(raw),
    });
    expect(res.status).toBe(200);

    // Background processing is fire-and-forget — poll for the effects.
    const msg = await waitFor(
      () =>
        prisma.message.findFirst({
          where: { tenantId, customerId: customer.id, direction: 'INBOUND' },
        }),
      { label: 'inbound message persisted' },
    );
    expect((msg.content as { text?: string }).text).toContain('interested');

    const updatedCustomer = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(updatedCustomer.stage).toBe('CONTACTED');

    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { tenantId, customerId: customer.id },
    });
    expect(conversation.lastMessageAt).not.toBeNull();

    // Core product promise: a reply halts all active sequences (stop-if-replied).
    await waitFor(
      () =>
        prisma.sequenceEnrollment.findFirst({
          where: { customerId: customer.id },
        }),
      { label: 'enrollment exists' },
    );
    const enrollment = await prisma.sequenceEnrollment.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(enrollment.status).toBe('STOPPED');
  });

  // ── Signature enforcement ────────────────────────────────────────────────
  it('rejects unsigned or wrongly-signed WhatsApp webhooks', async () => {
    const raw = inboundRawBody('+8613800000002', 'hi', 'wamid.inbound.2');

    const unsigned = await post(`${baseUrl}/webhooks/whatsapp`, raw);
    expect(unsigned.status).toBe(401);

    const wrong = await post(`${baseUrl}/webhooks/whatsapp`, raw, {
      'x-hub-signature-256': signMetaBody(raw, 'wrong-secret'),
    });
    expect(wrong.status).toBe(401);
  });

  // ── Outbound sequence dispatch → fake Graph API ──────────────────────────
  it('dispatches a due sequence step through the WhatsApp Graph API', async () => {
    const phone = '+8613800000003';
    const customer = await prisma.customer.create({
      data: { tenantId, externalId: phone, name: 'Zhang', phone, source: 'whatsapp' },
    });
    const channel = await prisma.channel.findFirstOrThrow({ where: { tenantId } });
    const sequence = await createSequence({
      tenantId,
      name: 'First touch',
      channelId: channel.id,
      steps: [
        {
          stepNumber: 1,
          delayMinutes: 0, // due immediately
          actionType: 'SEND_TEMPLATE',
          templateName: 'hello_there',
          language: 'en_US',
        },
      ],
    });
    await enrollInSequence(tenantId, sequence.id, customer.id);

    // Same routine the 60s scheduler invokes.
    const result = await processDueSteps();
    expect(result.sent).toBe(1);

    const call = graph.requests.find((r) => /\/messages$/.test(r.path) && r.method === 'POST');
    expect(call).toBeDefined();
    expect(call!.authorization).toBe('Bearer e2e-access-token');
    const body = call!.body as { to: string; template: { name: string; language: { code: string } } };
    expect(body.to).toBe(phone);
    expect(body.template.name).toBe('hello_there');
    expect(body.template.language.code).toBe('en_US');

    const enrollment = await prisma.sequenceEnrollment.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(enrollment.status).toBe('COMPLETED');
  });

  // ── Google lead import ───────────────────────────────────────────────────
  it('ingests a Google lead form submission into a customer profile', async () => {
    await prisma.leadSource.create({
      data: {
        tenantId,
        platform: 'GOOGLE',
        name: 'G Ads — Exporter Form',
        verifyToken: 'google-verify',
        isActive: true,
        config: { formId: 'e2e-form' },
      },
    });

    const res = await post(`${baseUrl}/leads/google?verifyToken=google-verify`, {
      lead_form_id: 'e2e-form',
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'Ana Smith' },
        { column_id: 'PHONE_NUMBER', string_value: '+1 555 123 4567' },
        { column_id: 'EMAIL', string_value: 'ana@acme.io' },
      ],
    });
    expect(res.status).toBe(200);

    const customer = await waitFor(
      () => prisma.customer.findFirst({ where: { tenantId, externalId: '+15551234567' } }),
      { label: 'customer created from Google lead' },
    );
    expect(customer!.name).toBe('Ana Smith');
    expect((customer!.attributes as Record<string, string>).EMAIL).toBe('ana@acme.io');
    expect(customer!.source).toBe('google_lead');

    // Unknown verify token → 404
    const unknown = await post(`${baseUrl}/leads/google?verifyToken=who`, {
      lead_form_id: 'e2e-form',
      user_column_data: [],
    });
    expect(unknown.status).toBe(404);
  });

  // ── Email tracking endpoints ─────────────────────────────────────────────
  it('records open/unsubscribe events for tracking tokens', async () => {
    await prisma.emailTrackingToken.create({
      data: { token: 'tk-e2e-1', tenantId, recipient: 'buyer@acme.io' },
    });

    const pixel = await fetch(`${baseUrl}/_track/tk-e2e-1/open.gif`);
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get('content-type')).toContain('image/gif');

    const unsub = await fetch(`${baseUrl}/_track/tk-e2e-1/unsubscribe`);
    expect(unsub.status).toBe(200);

    await waitFor(
      () =>
        prisma.emailEvent.findUnique({
          where: { trackToken_type: { trackToken: 'tk-e2e-1', type: 'OPENED' } },
        }),
      { label: 'opened event' },
    );
    const unsubEvent = await waitFor(
      () =>
        prisma.emailEvent.findUnique({
          where: { trackToken_type: { trackToken: 'tk-e2e-1', type: 'UNSUBSCRIBED' } },
        }),
      { label: 'unsubscribed event' },
    );
    expect(unsubEvent.recipient).toBe('buyer@acme.io');

    const token = await prisma.emailTrackingToken.findUniqueOrThrow({
      where: { token: 'tk-e2e-1' },
    });
    expect(token.unsubscribed).toBe(true);

    // Unique [trackToken, type] keeps the open event idempotent.
    const count = await prisma.emailEvent.count({
      where: { trackToken: 'tk-e2e-1', type: 'OPENED' },
    });
    expect(count).toBe(1);
  });
});
