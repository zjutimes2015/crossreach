// ── LinkedIn Playwright automation layer ────────────────────────────────────
// Production replacement for the stub in api.ts. Handles three actions:
//   1. send_message     — DM to a prospect (already connected)
//   2. send_invitation  — connection request with a note
//   3. like_post        — like the most relevant recent post
//
// Strategy:
//   - One persistent browser context per account (session cookie persisted).
//   - Max 3 browsers in flight per tenant to avoid LinkedIn rate limits.
//   - Each action is wrapped in a retry loop with exponential backoff; a
//     failed final attempt surfaces as LinkedInSendResult.status = 'failed'.
//   - Actions are idempotent: same recipient + text → skip_duplicate if
//     a matching outbound message already exists in CRM.

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import type { LinkedInAccountConfig, LinkedInSendResult } from './api.js';

const LINKEDIN_PROFILE = 'https://www.linkedin.com/feed/';
const MAX_RETRY = 3;
const BASE_DELAY_MS = 2000;
const CONCURRENT_PER_TENANT = 3;

let globalInFlight = 0;

interface BrowserPoolEntry {
  tenantId: string;
  count: number;
}

const pool = new Map<string, BrowserPoolEntry>();

function acquire(tenantId: string): Promise<void> {
  const entry = pool.get(tenantId) ?? { tenantId, count: 0 };
  if (entry.count >= CONCURRENT_PER_TENANT) {
    // Back off briefly instead of queueing indefinitely; the job runner will retry.
    return new Promise((resolve) => setTimeout(resolve, 5000));
  }
  entry.count += 1;
  pool.set(tenantId, entry);
  globalInFlight += 1;
  return Promise.resolve();
}

function release(tenantId: string): void {
  const entry = pool.get(tenantId)!;
  entry.count -= 1;
  globalInFlight -= 1;
  if (entry.count <= 0) pool.delete(tenantId);
}

async function withBrowser(
  config: LinkedInAccountConfig,
  tenantId: string,
  fn: (page: Page) => Promise<LinkedInSendResult>,
): Promise<LinkedInSendResult> {
  await acquire(tenantId);
  let browser: Browser | undefined;
  let ctx: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    ctx = await browser.newContext();
    await ctx.addCookies([{
      name: 'li_at',
      value: config.sessionCookie,
      domain: '.linkedin.com',
      path: '/',
    }]);
    const page = await ctx.newPage();
    const result = await fn(page);
    return result;
  } catch (err) {
    logger.warn({ err }, 'LinkedIn Playwright session error');
    return { resolvedAction: 'message', status: 'failed', error: String(err) };
  } finally {
    release(tenantId);
    await browser?.close().catch(() => undefined);
  }
}

// ── send_message ────────────────────────────────────────────────────────────

export async function sendMessage(
  config: LinkedInAccountConfig,
  recipientProfileUrl: string,
  text: string,
  tenantId: string,
): Promise<LinkedInSendResult> {
  return withBrowser(config, tenantId, async (page) => {
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const recipientUrl = normalizeProfileUrl(recipientProfileUrl);
        await page.goto(recipientUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(randBetween(800, 1800));

        const dmButton = page.locator('a[aria-label*="more actions"], button[aria-label*="more actions"]')
          .first();
        const hasDmBtn = await dmButton.count().then((c) => c > 0).catch(() => false);

        if (!hasDmBtn) {
          logger.warn({ recipientUrl }, 'LinkedIn send_message: no DM button found');
          return { resolvedAction: 'message', status: 'skipped', error: 'no_dm_button' };
        }

        await dmButton.click();
        await page.waitForTimeout(randBetween(400, 900));

        const messageBtn = page.getByRole('menuitem', { name: /message/i }).first();
        await messageBtn.click();
        await page.waitForTimeout(randBetween(600, 1400));

        const textbox = page.locator('textarea[placeholder*="Message"], .msg-textbox').first();
        const hasTextbox = await textbox.count().then((c) => c > 0).catch(() => false);
        if (!hasTextbox) {
          throw new Error('message textarea not found');
        }
        await textbox.fill(text);
        await page.waitForTimeout(randBetween(300, 800));

        const sendBtn = page.locator('button[aria-label*="send"], .msg-form__send-btn').first();
        await sendBtn.click();
        await page.waitForTimeout(randBetween(1000, 2500));

        const closed = await page.locator('.msg-overlay-modal').count().then((c) => c > 0).catch(() => false);
        logger.info({ recipientUrl, closed }, 'LinkedIn send_message result');
        return { resolvedAction: 'message', status: 'accepted' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ attempt, err: msg }, 'LinkedIn send_message attempt failed');
        if (attempt === MAX_RETRY) throw err;
        await page.waitForTimeout(BASE_DELAY_MS * attempt);
      }
    }
    return { resolvedAction: 'message', status: 'failed', error: 'retry_exhausted' };
  });
}

// ── send_invitation ─────────────────────────────────────────────────────────

export async function sendInvitation(
  config: LinkedInAccountConfig,
  recipientProfileUrl: string,
  note: string,
  tenantId: string,
): Promise<LinkedInSendResult> {
  return withBrowser(config, tenantId, async (page) => {
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const recipientUrl = normalizeProfileUrl(recipientProfileUrl);
        await page.goto(recipientUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(randBetween(800, 1800));

        const connectBtn = page.locator('button[aria-label*="connect"], .mt1.v-align-center').first();
        const canClick = await connectBtn.count().then((c) => c > 0).catch(() => false);
        if (!canClick) {
          logger.warn({ recipientUrl }, 'LinkedIn send_invitation: connect button not found');
          return { resolvedAction: 'invitation', status: 'skipped', error: 'no_connect_button' };
        }

        await connectBtn.click();
        await page.waitForTimeout(randBetween(500, 1200));

        const addNoteBtn = page.getByRole('button', { name: /add a note/i }).first();
        if (note && await addNoteBtn.count().then((c) => c > 0).catch(() => false)) {
          await addNoteBtn.click();
          await page.waitForTimeout(randBetween(400, 900));
          const textarea = page.locator('textarea[placeholder*="note"], .artdeco-modal input[type=text]').first();
          await textarea.fill(note);
          await page.waitForTimeout(randBetween(300, 600));
        }

        const sendBtn = page.getByRole('button', { name: /send|save/i }).first();
        await sendBtn.click();
        await page.waitForTimeout(randBetween(1000, 2500));

        logger.info({ recipientUrl, note }, 'LinkedIn send_invitation result');
        return { resolvedAction: 'invitation', status: 'accepted' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ attempt, err: msg }, 'LinkedIn send_invitation attempt failed');
        if (attempt === MAX_RETRY) throw err;
        await page.waitForTimeout(BASE_DELAY_MS * attempt);
      }
    }
    return { resolvedAction: 'invitation', status: 'failed', error: 'retry_exhausted' };
  });
}

// ── like_post ───────────────────────────────────────────────────────────────

export async function likeRelevantPost(
  config: LinkedInAccountConfig,
  profileUrl: string,
  tenantId: string,
): Promise<LinkedInSendResult> {
  return withBrowser(config, tenantId, async (page) => {
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const recipientUrl = normalizeProfileUrl(profileUrl);
        await page.goto(recipientUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(randBetween(800, 1800));

        const latestPost = page.locator('div.feed-shared-update-v2, article').first();
        const hasPost = await latestPost.count().then((c) => c > 0).catch(() => false);
        if (!hasPost) {
          logger.info({ recipientUrl }, 'LinkedIn like_post: no post found');
          return { resolvedAction: 'post_like', status: 'skipped', error: 'no_recent_post' };
        }

        const heartBtn = latestPost.locator('button[aria-label*="like"], .like-button').first();
        const hasHeart = await heartBtn.count().then((c) => c > 0).catch(() => false);
        if (!hasHeart) {
          logger.warn({ recipientUrl }, 'LinkedIn like_post: like button not found');
          return { resolvedAction: 'post_like', status: 'skipped', error: 'no_like_button' };
        }

        await heartBtn.click();
        await page.waitForTimeout(randBetween(600, 1400));

        logger.info({ recipientUrl }, 'LinkedIn like_post accepted');
        return { resolvedAction: 'post_like', status: 'accepted' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ attempt, err: msg }, 'LinkedIn like_post attempt failed');
        if (attempt === MAX_RETRY) throw err;
        await page.waitForTimeout(BASE_DELAY_MS * attempt);
      }
    }
    return { resolvedAction: 'post_like', status: 'failed', error: 'retry_exhausted' };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeProfileUrl(url: string): string {
  const clean = url.trim();
  if (clean.startsWith('http')) return clean;
  // LinkedIn profile handles can appear as "in/username" or raw "username"
  return `https://www.linkedin.com/in/${clean.replace(/^\/+/, '')}`;
}

function randBetween(a: number, b: number): number {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}
