// ── LinkedIn adapter (session-based, Playwright automation) ──────────────────
// Connect account config shape: { sessionCookie, profileUrl, cookiesPath }
//
// Execution strategy (mirrors Revor):
//   - Send a DM when the prospect is already connected (message).
//   - Otherwise send a connection request with a personalized note (invitation).
//   - likeRelevantPost likes the prospect's most recent public post (warm-up).
//
// The actual browser automation lives in playwright.ts. This file is the
// channel boundary consumed by modules/outreach/dispatch.ts and the
// connect-account test-connection flow.

import { logger } from '../../utils/logger.js';
import {
  sendMessage,
  sendInvitation,
  likeRelevantPost as playwrightLike,
} from './playwright.js';

// ── Types shared with playwright.ts & dispatch.ts ───────────────────────────

export interface LinkedInAccountConfig {
  sessionCookie: string;
  profileUrl?: string;
  cookiesPath?: string;
}

export type LinkedInAction = 'message' | 'invitation' | 'post_like';

export interface LinkedInRecipient {
  profileUrl: string;
  firstName?: string;
}

export interface LinkedInContent {
  text?: string;
  attachments?: Array<{ filename: string; contentBase64: string; contentType?: string }>;
}

export interface LinkedInSendResult {
  resolvedAction: LinkedInAction;
  status: 'accepted' | 'skipped' | 'failed';
  error?: string;
}

export interface LinkedInDispatchOptions {
  action?: LinkedInAction;
  /** Tenant id for the per-tenant Playwright concurrency pool. */
  tenantId?: string;
}

// ── Outcome predicates (pure, unit-testable) ────────────────────────────────

export const LINKEDIN_ERR_NO_DM = 'no_dm_button';
export const LINKEDIN_ERR_NO_CONNECT = 'no_connect_button';
export const LINKEDIN_ERR_NO_POST = 'no_recent_post';

/** True when the profile is reachable but we are NOT connected to it yet. */
export function isNotConnected(result: LinkedInSendResult): boolean {
  return result.status === 'skipped' && result.error === LINKEDIN_ERR_NO_DM;
}

/** True when we could not even find a "connect" entry point (private/restricted). */
export function isUnreachable(result: LinkedInSendResult): boolean {
  return result.status === 'skipped' && result.error === LINKEDIN_ERR_NO_CONNECT;
}

/**
 * Execute a LinkedIn action against a prospect.
 * Strategy (mirrors the product promise): DM when already connected; when the
 * profile is reachable but NOT connected, the same text is reused as the note
 * of a connection request (invitation fallback). Returns the actual outcome so
 * the dispatch layer can decide success/skip/fail honestly.
 */
export async function sendLinkedInAction(
  config: LinkedInAccountConfig,
  recipient: LinkedInRecipient,
  content: LinkedInContent,
  opts: LinkedInDispatchOptions = {},
): Promise<LinkedInSendResult> {
  const text = content.text ?? '';
  const tenantId = opts.tenantId ?? '';
  const chosen = opts.action ?? (text ? 'message' : 'invitation');

  if (chosen === 'post_like') {
    return playwrightLike(config, recipient.profileUrl, tenantId);
  }

  // Invitation requested explicitly (or there is nothing to DM).
  if (chosen === 'invitation') {
    if (!text) {
      return { resolvedAction: 'invitation', status: 'skipped', error: 'no_text_for_invitation' };
    }
    return sendInvitation(config, recipient.profileUrl, text, tenantId);
  }

  // DM requested and we have text: only possible when already connected.
  if (!text) {
    return { resolvedAction: 'message', status: 'skipped', error: 'no_text_for_message' };
  }
  const dm = await sendMessage(config, recipient.profileUrl, text, tenantId);
  if (isNotConnected(dm)) {
    logger.info({ profileUrl: recipient.profileUrl }, 'LinkedIn not connected — falling back to a connection request');
    return sendInvitation(config, recipient.profileUrl, text, tenantId);
  }
  return dm;
}

/**
 * Like the most relevant recent post on a prospect's LinkedIn profile.
 * Revor: POST /api/v1/outreach/linkedin/post-likes
 * Returns 'skipped' when no recent post is found or the button is unavailable.
 */
export async function likeRelevantPost(
  config: LinkedInAccountConfig,
  profileUrl: string,
  opts: { tenantId?: string } = {},
): Promise<LinkedInSendResult> {
  logger.info({ profileUrl }, 'LinkedIn post-like dispatched to automation layer');
  return playwrightLike(config, profileUrl, opts.tenantId ?? '');
}
