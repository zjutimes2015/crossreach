// Internal IM notifications — send team alerts to WeCom / Feishu / DingTalk
// group robot webhooks. Used for operational alerts (new lead, billing
// threshold, job complete) so the team sees them without opening the dashboard.
//
// Providers use their group-bot webhook endpoints which accept a POST with a
// small JSON payload. We build provider-specific payloads, then fan out to
// every webhook the operator has configured in env vars.

import { createHmac } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';

export type ImProvider = 'wecom' | 'feishu' | 'dingtalk';

export interface ImMessage {
  // Short bold title / first line (rendered as title where supported, else
  // prepended to text).
  title?: string;
  // Plain text body.
  text: string;
  // Optional markdown. Used when the provider supports it; skipped otherwise.
  markdown?: string;
}

interface ImTarget {
  provider: ImProvider;
  url: string;
  secret?: string;
}

function join(msg: ImMessage): string {
  return msg.title ? `${msg.title}\n${msg.text}` : msg.text;
}

// ── Per-provider payload builders (pure — unit-tested) ─────────────────────

export function buildWecomPayload(msg: ImMessage): Record<string, unknown> {
  if (msg.markdown) {
    return {
      msgtype: 'markdown',
      markdown: { content: msg.title ? `**${msg.title}**\n${msg.markdown}` : msg.markdown },
    };
  }
  return { msgtype: 'text', text: { content: join(msg) } };
}

export function buildFeishuPayload(msg: ImMessage): Record<string, unknown> {
  if (msg.markdown) {
    return {
      msg_type: 'interactive',
      card: {
        header: msg.title ? { title: { tag: 'plain_text', content: msg.title } } : undefined,
        elements: [{ tag: 'markdown', content: msg.markdown }],
      },
    };
  }
  return { msg_type: 'text', content: { text: join(msg) } };
}

export function buildDingtalkPayload(msg: ImMessage): Record<string, unknown> {
  if (msg.markdown) {
    return {
      msgtype: 'markdown',
      markdown: {
        title: msg.title ?? 'CrossReach 通知',
        text: msg.title ? `### ${msg.title}\n${msg.markdown}` : msg.markdown,
      },
    };
  }
  return { msgtype: 'text', text: { content: join(msg) } };
}

/**
 * DingTalk custom-robot "加签" (signature) security.
 * sign = urlEncode( base64( hmac_sha256(key=`{ts}\n{secret}`, msg='') ) )
 * Append `&timestamp={ts}&sign={sign}` to the webhook URL.
 */
export function dingtalkSign(secret: string, timestampMs: number): string {
  const stringToSign = `${timestampMs}\n${secret}`;
  const digest = createHmac('sha256', stringToSign).update('').digest('base64');
  return encodeURIComponent(digest);
}

// ── Target resolution from config ──────────────────────────────────────────

export function getConfiguredTargets(): ImTarget[] {
  const targets: ImTarget[] = [];
  if (config.WECOM_WEBHOOK_URL) targets.push({ provider: 'wecom', url: config.WECOM_WEBHOOK_URL });
  if (config.FEISHU_WEBHOOK_URL) targets.push({ provider: 'feishu', url: config.FEISHU_WEBHOOK_URL });
  if (config.DINGTALK_WEBHOOK_URL) {
    targets.push({
      provider: 'dingtalk',
      url: config.DINGTALK_WEBHOOK_URL,
      secret: config.DINGTALK_SECRET,
    });
  }
  return targets;
}

// ── Send to a single target ────────────────────────────────────────────────

export async function sendToTarget(
  target: ImTarget,
  msg: ImMessage,
  now = Date.now(),
): Promise<{ ok: boolean; provider: ImProvider; status?: number }> {
  let url = target.url;
  let body: Record<string, unknown>;

  switch (target.provider) {
    case 'wecom':
      body = buildWecomPayload(msg);
      break;
    case 'feishu':
      body = buildFeishuPayload(msg);
      break;
    case 'dingtalk':
      body = buildDingtalkPayload(msg);
      if (target.secret) {
        const timestamp = now;
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}timestamp=${timestamp}&sign=${dingtalkSign(target.secret, timestamp)}`;
      }
      break;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Group-bot APIs return 200 even for business errors, so that's fine to
  // treat as delivered; surface non-2xx as failures.
  return { ok: response.ok, provider: target.provider, status: response.status };
}

// ── Fan-out to all configured webhooks ─────────────────────────────────────

/**
 * Send a team alert to every configured IM webhook. Never throws — failures
 * are logged so an unreachable webhook can't take down the caller.
 */
export async function notifyTeam(msg: ImMessage): Promise<void> {
  const targets = getConfiguredTargets();
  if (targets.length === 0) return;

  const results = await Promise.allSettled(targets.map((t) => sendToTarget(t, msg)));
  for (let i = 0; i < targets.length; i++) {
    const r = results[i] as PromiseSettledResult<{ ok: boolean; provider: ImProvider; status?: number }>;
    if (r.status === 'rejected') {
      logger.warn({ err: r.reason, provider: targets[i].provider }, 'IM notification failed');
    } else if (!r.value.ok) {
      logger.warn(
        { provider: targets[i].provider, status: r.value.status },
        'IM notification rejected by webhook',
      );
    }
  }
}

/** Fire-and-forget convenience: run notifyTeam and swallow async backpressure. */
export function notifyTeamAsync(msg: ImMessage): void {
  notifyTeam(msg).catch((err) => logger.warn({ err }, 'IM notification fired but errored'));
}