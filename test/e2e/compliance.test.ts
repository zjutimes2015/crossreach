// E2E: compliance evidence chain (外呼合规证据链).
// Real server + real DB. Proves that:
//   • unsubscribe clicks auto-register into the suppression registry
//   • EMAIL / WhatsApp outreach dispatches to suppressed contacts HARD-BLOCK
//     (job FAILED with code suppressed_recipient + matched suppression row)
//   • the block does not touch the upstream channel (no Graph call)
//   • evidence timeline + CSV export expose the same records
//   • 申诉解除 only soft-deletes: re-adding keeps the original opt-out date.
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

async function pollJobStatus(jobId: string): Promise<any> {
  return waitFor(
    async () => {
      const { body } = await getJson(`/api/v1/outreach/jobs/${jobId}`);
      const item = body?.item;
      return item && item.status !== 'QUEUED' && item.status !== 'SCHEDULED' && item.status !== 'RUNNING' ? item : null;
    },
    { label: `outreach job ${jobId} settles`, timeout: 15000 },
  );
}

async function createDispatch(payload: unknown): Promise<string> {
  const { status, body } = await postJson('/api/v1/outreach/dispatches', payload);
  expect(status).toBe(202);
  expect(body.ok).toBe(true);
  return body.item.id as string;
}

describe('E2E compliance chain', () => {
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
        name: 'E2E Compliance Co.',
        plan: 'GROWTH',
        status: 'ACTIVE',
        apiKey: E2E_API_KEY,
      },
    });
    tenantId = tenant.id;
  });

  it('auto-registers an unsubscribe click and exposes it in evidence + CSV', async () => {
    await prisma.emailTrackingToken.create({
      data: { token: 'tk-e2e-unsub', tenantId, recipient: 'buyer@acme.io' },
    });

    const unsub = await fetch(`${baseUrl}/_track/tk-e2e-unsub/unsubscribe`);
    expect(unsub.status).toBe(200);

    const list = await waitFor(
      async () => {
        const { body } = await getJson('/api/v1/compliance/suppressions');
        const entry = (body?.suppressions ?? []).find((s: any) => s.contact === 'buyer@acme.io');
        return entry ?? null;
      },
      { label: 'unsubscribe suppressed entry' },
    );
    expect(list.reason).toBe('UNSUBSCRIBED');
    expect(list.channel).toBe('EMAIL');

    // Timeline aggregates the suppression + the unsubscribe event.
    const ev = await getJson('/api/v1/compliance/evidence?contact=buyer@acme.io');
    expect(ev.status).toBe(200);
    const kinds = (ev.body.items as Array<{ kind: string }>).map((i) => i.kind);
    expect(kinds).toContain('SUPPRESSION');
    expect(kinds).toContain('UNSUBSCRIBED');

    // CSV export includes the same row.
    const csvRes = await fetch(
      `${baseUrl}/api/v1/compliance/evidence/export?contact=buyer@acme.io`,
      { headers: authHeaders },
    );
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('content-type')).toContain('text/csv');
    const csv = await csvRes.text();
    expect(csv.split('\n')[0]).toBe('timestamp,kind,channel,contact,account,reference,status,detail');
    expect(csv).toContain('buyer@acme.io');
    expect(csv).toContain('SUPPRESSION');
  });

  it('hard-blocks EMAIL and WhatsApp dispatches to suppressed recipients and refunds', async () => {
    const email = 'blocked@acme.io';
    const phone = '+8613800000009';

    // Connected accounts so the only thing standing in the way is compliance.
    const emailAccount = await prisma.connectAccount.create({
      data: {
        tenantId,
        channel: 'EMAIL',
        name: 'E2E Inbox',
        status: 'ACTIVE',
        config: {
          smtpHost: 'smtp.invalid', smtpPort: 587, smtpUser: 'u', smtpPass: 'p',
          fromAddress: 'ops@co.com', fromName: 'Ops', dailyLimit: 60,
        },
      },
    });
    const waAccount = await prisma.connectAccount.create({
      data: {
        tenantId,
        channel: 'WHATSAPP',
        name: 'E2E WhatsApp',
        status: 'ACTIVE',
        config: {
          phoneNumberId: E2E_PHONE_NUMBER_ID,
          accessToken: 'e2e-access-token',
          verifyToken: WHATSAPP_VERIFY_TOKEN,
          apiVersion: 'v18.0',
        },
      },
    });

    // Suppress both identities via the API (manual 申诉/登记 path).
    const addEmail = await postJson('/api/v1/compliance/suppressions', {
      channel: 'EMAIL', contact: email, reason: 'MANUAL', note: 'asked on a call',
    });
    expect(addEmail.status).toBe(200);
    const emailEntryId = addEmail.body.suppression.id as string;
    const emailAddedAt = addEmail.body.suppression.createdAt as string;

    const addWa = await postJson('/api/v1/compliance/suppressions', {
      channel: 'WHATSAPP', contact: phone, reason: 'COMPLAINED',
    });
    expect(addWa.status).toBe(200);

    // EMAIL dispatch → job FAILED suppressed_recipient (no SMTP attempted).
    const balBefore = await getJson('/api/v1/billing/balance');
    const availableBefore = balBefore.body.balance.available as number;
    const emailJobId = await createDispatch({
      connectAccountId: emailAccount.id,
      channel: 'EMAIL',
      recipient: { address: email },
      content: { subject: 'Hi', text: 'Still reaching out?' },
    });
    const emailJob = await pollJobStatus(emailJobId);
    expect(emailJob.status).toBe('FAILED');
    expect(emailJob.error.code).toBe('suppressed_recipient');
    expect(emailJob.error.compliance.suppressionId).toBe(emailEntryId);
    expect(emailJob.error.compliance.reason).toBe('MANUAL');

    // The pre-charged credit is refunded on a compliance block: balance returns
    // to exactly what it was before the dispatch (refund lands just after the
    // job flips to FAILED, so poll instead of asserting immediately).
    await waitFor(
      async () => {
        const { body } = await getJson('/api/v1/billing/balance');
        return body?.balance?.available === availableBefore;
      },
      { label: 'credit refunded after compliance block', timeout: 10000 },
    );

    // WhatsApp dispatch → blocked before the Graph call; upstream never sees it.
    const graphCallsBefore = graph.requests.filter((r) => r.method === 'POST' && /\/messages$/.test(r.path)).length;
    const waJobId = await createDispatch({
      connectAccountId: waAccount.id,
      channel: 'WHATSAPP',
      recipient: { phone },
      content: { text: 'hello again' },
    });
    const waJob = await pollJobStatus(waJobId);
    expect(waJob.status).toBe('FAILED');
    expect(waJob.error.code).toBe('suppressed_recipient');
    expect(waJob.error.compliance.contact).toBe('8613800000009');
    const graphCallsAfter = graph.requests.filter((r) => r.method === 'POST' && /\/messages$/.test(r.path)).length;
    expect(graphCallsAfter).toBe(graphCallsBefore);

    // Evidence timeline records the blocked attempts (可查询、可申诉).
    const evidence = await getJson('/api/v1/compliance/evidence?contact=blocked@acme.io');
    expect(evidence.status).toBe(200);
    const kinds = (evidence.body.items as Array<{ kind: string }>).map((i) => i.kind);
    expect(kinds).toContain('SUPPRESSION');
    expect(kinds).toContain('OUTREACH_FAILED');

    // 申诉解除 = soft delete; re-adding preserves the ORIGINAL opt-out date.
    const del = await fetch(`${baseUrl}/api/v1/compliance/suppressions/${emailEntryId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(del.status).toBe(200);

    const history = await getJson('/api/v1/compliance/suppressions?contact=blocked@acme.io&includeInactive=true');
    const removed = (history.body.suppressions as any[]).find((s) => s.id === emailEntryId);
    expect(removed.active).toBe(false);
    expect(removed.removedAt).not.toBeNull();

    const readd = await postJson('/api/v1/compliance/suppressions', {
      channel: 'EMAIL', contact: email, reason: 'MANUAL', note: 're-added after appeal review',
    });
    expect(readd.body.suppression.active).toBe(true);
    expect(readd.body.suppression.createdAt).toBe(emailAddedAt); // first opt-out date kept

    // And the re-activated block still gates new sends.
    const againJobId = await createDispatch({
      connectAccountId: emailAccount.id,
      channel: 'EMAIL',
      recipient: { address: email },
      content: { subject: 'Second try', text: 'hi' },
    });
    const again = await pollJobStatus(againJobId);
    expect(again.status).toBe('FAILED');
    expect(again.error.code).toBe('suppressed_recipient');
  });
});
