// ── LinkedIn adapter (session-based, Playwright-ready) ─────────────────────
// Connect account config shape:
//   { sessionCookie, profileUrl, cookiesPath }
//
// LinkedIn automation requires a browser session (no official outbound API).
// Production: drive Playwright with the stored session cookie.
// MVP: stub that records intent + returns a queued result so the dispatch
// pipeline and job-status API work end-to-end. The Playwright execution
// layer plugs in here without touching the rest of the system.

import { logger } from '../../utils/logger.js';

export interface LinkedInAccountConfig {
  sessionCookie: string;
  profileUrl?: string;
  cookiesPath?: string;
}

export type LinkedInAction =
  | 'message'        // send a DM (already connected)
  | 'invitation'     // send a connection request with a note
  | 'post_like';     // like the most relevant recent post

export interface LinkedInRecipient {
  profileUrl: string;
}

export interface LinkedInContent {
  text?: string;
  attachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType?: string;
  }>;
}

export interface LinkedInSendResult {
  resolvedAction: LinkedInAction;
  status: 'accepted' | 'skipped' | 'failed';
  error?: string;
}

/**
 * Resolve which LinkedIn action to perform.
 * Revor's logic: send a message if already connected, otherwise send an
 * invitation when appropriate.
 */
export function resolveAction(): LinkedInAction {
  // MVP: always attempt a message. In production, Playwright checks the
  // connection state on the profile page and downgrades to invitation.
  return 'message';
}

/**
 * Execute a LinkedIn action.
 * MVP: stub that logs intent and returns accepted, so the outreach job
 * completes and can be polled via GET /api/v1/outreach/jobs/:id.
 *
 * Production replacement:
 *   const browser = await chromium.launch({ headless: true });
 *   const ctx = await browser.newContext();
 *   await ctx.addCookies([{ name: 'li_at', value: config.sessionCookie, ... }]);
 *   const page = await ctx.newPage();
 *   await page.goto(recipient.profileUrl);
 *   // ... interact based on action
 */
export async function sendLinkedInAction(
  config: LinkedInAccountConfig,
  recipient: LinkedInRecipient,
  content: LinkedInContent,
  action: LinkedInAction = resolveAction(),
): Promise<LinkedInSendResult> {
  logger.info(
    { action, profileUrl: recipient.profileUrl, hasText: !!content.text },
    'LinkedIn action queued (Playwright execution layer not yet wired)',
  );

  // MVP stub: accept the action so jobs complete successfully.
  // When Playwright is wired, replace this block with real browser automation.
  return {
    resolvedAction: action,
    status: 'accepted',
  };
}

/**
 * Like the most relevant recent post on a prospect's LinkedIn profile.
 * Revor: POST /api/v1/outreach/linkedin/post-likes
 * MVP: stub returning "skipped" (no relevant post found).
 */
export async function likeRelevantPost(
  config: LinkedInAccountConfig,
  profileUrl: string,
): Promise<LinkedInSendResult> {
  logger.info(
    { profileUrl },
    'LinkedIn post-like queued (Playwright execution layer not yet wired)',
  );

  return {
    resolvedAction: 'post_like',
    status: 'skipped',
  };
}
