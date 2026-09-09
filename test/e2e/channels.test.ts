// E2E: outbound channel chain clarity (WhatsApp + LinkedIn) — real server, real
// DB, fake Meta Graph. Proves the whole loop for each channel the user asked
// about is coherent end to end:
//   connect account → live "test connection" (verified) → outreach dispatch
//   → provider call with the exact payload → job SUCCEEDED + messageId →
//   evidence timeline row.
//
// LinkedIn's browser automation cannot run against LinkedIn itself in CI, so
// the LinkedIn half verifies: connect + cookie validation + the dispatch-side
// contract (compliance gate, validation) which are the parts CI can reach.
//
// Env must be configured BEFORE importing src (config/prisma read env at load).
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  E2E_API_KEY,
  E2E_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  applyE2EEnv,
  startFakeGraphServer,
  resetDatabase,
  bootApp,
  waitFor,
} from './helpers.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

const graph = await startFakeGraphServer();
applyE2EEnv(graph.url);

const { prisma } = await import('../../src/db/prisma.js');

let app: FastifyInstance;
let baseUrl: string;
let tenantId: string;

const headers = { 'x-api-key': E2E_API_KEY, 'content-type': 'application/json' };

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function graphPosts(): Promise<Array<{ path: string; authorization?: string; body: any }>> {
  return graph.requests.filter((r) => r.method === 'POST' && /\/messages$/.test(r.path));
}

const WA_CONFIG = {
  phoneNumberId: E2E_PHONE_NUMBER_ID,
  accessToken: 'e2e-access-token',
  verifyToken: WHATSAPP_VERIFY_TOKEN,
  apiVersion: 'v18.0',
};

describe('E2E outbound channel chain', () => {
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
        name: 'E2E Channels Co.',
        plan: 'PRO', // social quota ≥ 2 so LinkedIn + WhatsApp can both connect
        status: 'ACTIVE',
        apiKey: E2E_API_KEY,
      },
    });
    tenantId = tenant.id;
  });

  it('connects WhatsApp and LinkedIn accounts and live-verifies both', async () => {
    // WhatsApp — POST /connect/accounts then POST /:id/test (fake Graph GET).
    const wa = await call('POST', '/api/v1/connect/accounts', {
      channel: 'WHATSAPP',
      name: 'E2E WhatsApp',
      config: WA_CONFIG,
    });
    expect(wa.status).toBe(201);
    const waId = wa.body.account.id as string;

    const waTest = await call('POST', `/api/v1/connect/accounts/${waId}/test`);
    expect(waTest.status).toBe(200);
    expect(waTest.body.ok).toBe(true);
    expect(waTest.body.status).toBe('verified');
    expect(String(waTest.body.detail)).toContain('15550000000');

    // One sending account per channel — a duplicate WhatsApp is rejected.
    const dup = await call('POST', '/api/v1/connect/accounts', {
      channel: 'WHATSAPP',
      name: 'E2E WhatsApp 2',
      config: WA_CONFIG,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('channel_already_connected');

    // LinkedIn — cookie presence is the verifiable part without a browser.
    // A too-short cookie must fail verification (guards bad links early)…
    const liBad = await call('POST', '/api/v1/connect/accounts', {
      channel: 'LINKEDIN',
      name: 'E2E LinkedIn Bad',
      config: { sessionCookie: 'short' },
    });
    expect(liBad.status).toBe(201);
    const liBadTest = await call('POST', `/api/v1/connect/accounts/${liBad.body.account.id}/test`);
    expect(liBadTest.body.ok).toBe(false);
    expect(String(liBadTest.body.detail)).toContain('sessionCookie missing or too short');
    await call('DELETE', `/api/v1/connect/accounts/${liBad.body.account.id}`);

    // …while a real li_at-shaped cookie verifies.
    const li = await call('POST', '/api/v1/connect/accounts', {
      channel: 'LINKEDIN',
      name: 'E2E LinkedIn',
      config: { sessionCookie: 'AQED-e2e-session-cookie-0123456789abcdef', profileUrl: 'https://linkedin.com/in/e2e' },
    });
    expect(li.status).toBe(201);
    const liId = li.body.account.id as string;
    const liTest = await call('POST', `/api/v1/connect/accounts/${liId}/test`);
    expect(liTest.status).toBe(200);
    expect(liTest.body.ok).toBe(true);
    expect(liTest.body.status).toBe('verified');
    expect(String(liTest.body.detail)).toContain('session cookie present');
  });

  it('dispatches a WhatsApp text end-to-end: accepted → provider call → job + evidence', async () => {
    const acc = await call('POST', '/api/v1/connect/accounts', {
      channel: 'WHATSAPP',
      name: 'E2E WhatsApp',
      config: WA_CONFIG,
    });
    expect(acc.status).toBe(201);
    const accountId = acc.body.account.id as string;
    const phone = '+8613912340001';

    const before = (await graphPosts()).length;

    const dispatch = await call('POST', '/api/v1/outreach/dispatches', {
      connectAccountId: accountId,
      channel: 'WHATSAPP',
      recipient: { phone },
      content: { text: 'Hi Emma — quick question about your exporter workflow?' },
    });
    expect(dispatch.status).toBe(202);
    const jobId = dispatch.body.item.id as string;

    // The job settles SUCCEEDED with the provider message id persisted.
    const job = await waitFor(
      async () => {
        const { body } = await call('GET', `/api/v1/outreach/jobs/${jobId}`);
        const item = body?.item;
        return item && item.status === 'SUCCEEDED' ? item : null;
      },
      { label: 'WhatsApp dispatch succeeds', timeout: 15000 },
    );
    expect(job.result.messageId).toMatch(/^wamid\.e2e\./);
    expect(job.result.status).toBe('accepted');

    // The provider really received the exact message we queued.
    const posts = await graphPosts();
    expect(posts.length).toBe(before + 1);
    const sent = posts[posts.length - 1];
    expect(sent.authorization).toBe('Bearer e2e-access-token');
    expect(sent.body.to).toBe(phone);
    expect(sent.body.type).toBe('text');
    expect(sent.body.text.body).toContain('exporter workflow');

    // And the compliance evidence timeline shows the successful outreach.
    const evidence = await call('GET', `/api/v1/compliance/evidence?channel=WHATSAPP&contact=${encodeURIComponent(phone)}`);
    expect(evidence.status).toBe(200);
    const kinds = (evidence.body.items as Array<{ kind: string }>).map((i) => i.kind);
    expect(kinds).toContain('OUTREACH_SUCCEEDED');
    expect((evidence.body.items as Array<{ contact: string }>)[0].contact).toBe(phone);
  });
});
