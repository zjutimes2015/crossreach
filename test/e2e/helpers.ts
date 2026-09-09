// E2E helpers — boot the real server against a dedicated Postgres and local
// fake upstreams. IMPORTANT: nothing in this module may import from src/ at
// module top-level. Callers must set process.env (applyE2EEnv) BEFORE the
// first dynamic import of src modules (config/prisma read env at load time).
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

// ── Environment ────────────────────────────────────────────────────────────

export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://postgres@localhost:5432/crossreach_e2e?schema=public';
export const META_APP_SECRET = 'e2e-meta-app-secret';
export const WHATSAPP_VERIFY_TOKEN = 'e2e-verify-token';
export const E2E_API_KEY = 'e2e-api-key-0001';
export const E2E_PHONE_NUMBER_ID = 'e2e-phone-id';

/** Set env vars the backend reads at import time. Call before importing src. */
export function applyE2EEnv(graphBaseUrl: string): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = E2E_DATABASE_URL;
  process.env.META_APP_SECRET = META_APP_SECRET;
  process.env.WHATSAPP_GRAPH_BASE_URL = graphBaseUrl;
  process.env.WHATSAPP_VERIFY_TOKEN = WHATSAPP_VERIFY_TOKEN;
  process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
  process.env.LOG_LEVEL = 'silent';
}

// ── Fake WhatsApp Graph API ────────────────────────────────────────────────
// Faithful at the HTTP level: accepts POST /{version}/{phone_number_id}/messages
// and replies with the same shape as the Meta Graph endpoint. Captures calls
// so tests can assert what the app actually sent.

export interface CapturedGraphRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export async function startFakeGraphServer(): Promise<{
  url: string;
  requests: CapturedGraphRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedGraphRequest[] = [];
  let counter = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && /\/messages$/.test(req.url ?? '')) {
        counter++;
        res.end(
          JSON.stringify({
            messaging_product: 'whatsapp',
            contacts: [],
            messages: [{ id: `wamid.e2e.${counter}` }],
          }),
        );
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── HMAC signing (WhatsApp webhook verification) ───────────────────────────

export function signMetaBody(rawBody: string, secret = META_APP_SECRET): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(rawBody);
  return `sha256=${hmac.digest('hex')}`;
}

// ── Database ───────────────────────────────────────────────────────────────

/** Wipe all app data. CASCADE reaches every table that references the roots. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE tenants, customers, sequences, lead_sources, ' +
      'connect_accounts, outreach_jobs, email_tracking_tokens, email_events, ' +
      'webhook_events CASCADE',
  );
}

// ── Server boot ────────────────────────────────────────────────────────────

export async function bootApp(): Promise<{
  app: FastifyInstance;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  // Import lazily so env vars are already set when config/prisma initialize.
  const { buildServer } = await import('../../src/api/server.js');
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, baseUrl, close: () => app.close() };
}

// ── Polling helper (background webhook processing is fire-and-forget) ──────

export async function waitFor<T>(
  fn: () => Promise<T | null | false>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const timeout = opts.timeout ?? 10000;
  const interval = opts.interval ?? 100;
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out waiting for: ${opts.label ?? 'condition'}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Minimal POST helper that returns { status, body }. */
export async function post(
  url: string,
  rawBody: string | object,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const isString = typeof rawBody === 'string';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: isString ? (rawBody as string) : JSON.stringify(rawBody),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
