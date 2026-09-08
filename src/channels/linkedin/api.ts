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

/** Provisional action selection — refined by the Playwright layer using the
 *  live connection state seen on the profile page. */
export function resolveAction(): LinkedInAction {
  return 'message';
}

/**
 * Execute a LinkedIn action against a prospect.
 * Defaults to a DM when text is present; falls back to an invitation with the
 * same text used as the connection note when the prospect is not connected.
 */
export async function sendLinkedInAction(
  config: LinkedInAccountConfig,
  recipient: LinkedInRecipient,
  content: LinkedInContent,
  action?: LinkedInAction,
): Promise<LinkedInSendResult> {
  const chosen = action ?? resolveAction();
  const text = content.text ?? '';

  if (chosen === 'message' && text) {
    return sendMessage(config, recipient.profileUrl, text, '');
  }
  if (chosen === 'invitation' || (chosen === 'message' && !text)) {
    return sendInvitation(config, recipient.profileUrl, text, '');
  }
  if (chosen === 'post_like') {
    return playwrightLike(config, recipient.profileUrl, '');
  }
  return { resolvedAction: chosen, status: 'skipped', error: 'no_text_for_message' };
}

/**
 * Like the most relevant recent post on a prospect's LinkedIn profile.
 * Revor: POST /api/v1/outreach/linkedin/post-likes
 * Returns 'skipped' when no recent post is found or the button is unavailable.
 */
export async function likeRelevantPost(
  config: LinkedInAccountConfig,
  profileUrl: string,
): Promise<LinkedInSendResult> {
  logger.info({ profileUrl }, 'LinkedIn post-like dispatched to automation layer');
  return playwrightLike(config, profileUrl, '');
}
