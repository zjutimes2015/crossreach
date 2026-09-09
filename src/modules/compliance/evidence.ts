// ── Compliance evidence aggregation (外呼合规证据链 — 查询/导出) ──────────────
// Pulls every outbound-reach artifact into ONE chronological timeline for audit
// or dispute review:
//   • suppression registry rows        → when/how a recipient opted out
//   • email tracking events            → sent/delivered/open/click/bounce/…
//   • outreach jobs                    → dispatch attempt + outcome (incl.
//                                       suppressed_recipient blocks)
//   • WhatsApp campaign recipients     → broadcast sends per recipient
//
// The CSV renderer is pure (unit-testable); the store pulls are plain Prisma.

import type { SuppressionChannel } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  findSuppressionMatch,
  normalizeContact,
} from './suppression.js';

export interface EvidenceItem {
  ts: string;                 // ISO timestamp
  kind: string;               // e.g. SENT / OPENED / UNSUBSCRIBED / SUPPRESSION /
                              // OUTREACH_SUCCEEDED / CAMPAIGN_SENT
  channel: string;            // EMAIL | WHATSAPP | LINKEDIN
  contact: string;            // normalized-ish display of the recipient identity
  accountId?: string | null;
  refId?: string | null;      // tracking token / job / campaign-recipient id
  status?: string | null;
  detail?: string | null;     // subject / template / error / reason text
}

export interface EvidenceQuery {
  channel?: SuppressionChannel;
  contact?: string;
  from?: Date;
  to?: Date;
  /** Hard cap on rows returned (default 500, max 5000). */
  limit?: number;
}

export const EVIDENCE_COLUMNS = [
  'timestamp',
  'kind',
  'channel',
  'contact',
  'account',
  'reference',
  'status',
  'detail',
] as const;

// ── Pure helpers ───────────────────────────────────────────────────────────

export function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(items: EvidenceItem[]): string {
  const header = EVIDENCE_COLUMNS.join(',');
  const rows = items.map((it) =>
    [
      csvField(it.ts),
      csvField(it.kind),
      csvField(it.channel),
      csvField(it.contact),
      csvField(it.accountId ?? ''),
      csvField(it.refId ?? ''),
      csvField(it.status ?? ''),
      csvField(it.detail ?? ''),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

interface RowContact {
  channel: SuppressionChannel;
  contact?: string | null;
}

/** Decide whether a source row is relevant for a query's channel+contact. */
export function evidenceRowMatches(
  row: RowContact,
  query: EvidenceQuery,
): boolean {
  if (query.channel && row.channel !== query.channel) return false;
  if (!query.contact || !row.contact) return !query.contact;

  if (query.channel) {
    // Normalize the row's own contact (registry rows are stored normalized,
    // arbitrary source rows like jobs/tokens may not be).
    const normRow = { channel: row.channel, contact: normalizeContact(row.channel, row.contact) };
    return findSuppressionMatch([normRow], row.channel, query.contact) !== null;
  }

  // Channel unknown — loose contains on the normalized display + digit suffix.
  const needle = query.contact.trim().toLowerCase();
  const haystack = normalizeContact(row.channel, row.contact).toLowerCase();
  if (!needle || haystack.includes(needle)) return true;
  if (row.channel === 'WHATSAPP' && haystack.length >= 9) {
    const suffix = haystack.slice(-9);
    const needleDigits = normalizeContact('WHATSAPP', query.contact);
    return needleDigits.length >= 9 && (needleDigits.endsWith(suffix) || needleDigits.slice(-9) === suffix);
  }
  return false;
}

export function clampLimit(limit?: number): number {
  if (!limit) return 500;
  return Math.min(Math.max(Math.floor(limit), 1), 5000);
}

// ── Store pulls ────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString();

export async function buildEvidenceTimeline(
  tenantId: string,
  query: EvidenceQuery = {},
): Promise<{ items: EvidenceItem[]; truncated: boolean }> {
  const cap = clampLimit(query.limit);
  // When filtering by a contact we over-fetch per source so the JS matcher has
  // a realistic window (jobs/campaign rows can't be filtered by JSON in SQL).
  const fetch = query.contact ? Math.min(cap * 4, 4000) : cap;
  const range = {
    ...(query.from ? { gte: query.from } : {}),
    ...(query.to ? { lte: query.to } : {}),
  };

  const items: EvidenceItem[] = [];

  // 1. Suppression history (active + removed rows are all evidence).
  const suppressions = await prisma.suppression.findMany({
    where: {
      tenantId,
      ...(query.channel ? { channel: query.channel } : {}),
      ...(range.gte || range.lte ? { createdAt: range } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: fetch,
  });
  for (const s of suppressions) {
    if (!evidenceRowMatches({ channel: s.channel, contact: s.contact }, query)) continue;
    items.push({
      ts: iso(s.removedAt ?? s.createdAt),
      kind: s.active ? 'SUPPRESSION' : 'SUPPRESSION_REMOVED',
      channel: s.channel,
      contact: s.contact,
      refId: s.id,
      status: s.active ? s.reason : `REMOVED (was ${s.reason})`,
      detail: [s.note, s.source ? `source: ${s.source}` : ''].filter(Boolean).join(' · ') || null,
    });
  }

  // 2. Outreach jobs (dispatch attempts + outcomes across every channel).
  const jobs = await prisma.outreachJob.findMany({
    where: { tenantId, ...(query.channel ? { channel: query.channel } : {}), ...(range.gte || range.lte ? { createdAt: range } : {}) },
    orderBy: { createdAt: 'desc' },
    take: fetch,
  });
  for (const job of jobs) {
    const recipient = (job.recipient as Record<string, unknown>) ?? {};
    const content = (job.content as Record<string, unknown>) ?? {};
    const rowChannel = job.channel as SuppressionChannel;
    const contact = String(
      (recipient.address as string) ?? (recipient.phone as string) ?? (recipient.profileUrl as string) ?? '',
    );
    if (!evidenceRowMatches({ channel: rowChannel, contact }, query)) continue;
    const error = (job.error as { code?: string; message?: string } | null) ?? null;
    items.push({
      ts: iso(job.finishedAt ?? job.startedAt ?? job.scheduledAt ?? job.createdAt),
      kind: `OUTREACH_${job.status}`,
      channel: rowChannel,
      contact,
      accountId: job.connectAccountId,
      refId: job.id,
      status: job.status,
      detail:
        error?.code === 'suppressed_recipient'
          ? `blocked: ${error.code} — ${error.message}`
          : (content.subject as string) ?? null,
    });
  }

  // 3. WhatsApp campaign sends (per recipient).
  const campaignRecipients = await prisma.campaignRecipient.findMany({
    where: { tenantId, ...(range.gte || range.lte ? { createdAt: range } : {}) },
    orderBy: { createdAt: 'desc' },
    take: fetch,
    include: {
      campaign: { include: { channel: true } },
      customer: { select: { name: true, email: true, phone: true, externalId: true } },
    },
  });
  for (const cr of campaignRecipients) {
    const c = cr.customer;
    const contact = String(c?.email ?? c?.phone ?? c?.externalId ?? '');
    if (!evidenceRowMatches({ channel: 'WHATSAPP', contact }, query)) continue;
    items.push({
      ts: iso(cr.sentAt ?? cr.createdAt),
      kind: `CAMPAIGN_${cr.status}`,
      channel: 'WHATSAPP',
      contact,
      refId: cr.id,
      status: cr.status,
      detail: cr.campaign.templateName || cr.campaign.name,
    });
  }

  // 4. Email tracking events (sent → delivered → open/click/bounce/…).
  const tokens = await prisma.emailTrackingToken.findMany({
    where: {
      tenantId,
      ...(query.contact ? { recipient: { contains: query.contact, mode: 'insensitive' } } : {}),
      ...(range.gte || range.lte ? { createdAt: range } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: fetch,
    select: {
      token: true,
      accountId: true,
      jobId: true,
      customerId: true,
      recipient: true,
      messageId: true,
    },
  });
  if (tokens.length > 0) {
    const tokenSet = new Set(tokens.map((t) => t.token));
    const events = await prisma.emailEvent.findMany({
      where: { tenantId, trackToken: { in: [...tokenSet] } },
      orderBy: { createdAt: 'desc' },
      take: fetch,
    });
    const tokenOf = new Map(tokens.map((t) => [t.token, t]));
    for (const ev of events) {
      const tok = tokenOf.get(ev.trackToken ?? '');
      if (!tok) continue;
      if (!evidenceRowMatches({ channel: 'EMAIL', contact: tok.recipient }, query)) continue;
      items.push({
        ts: iso(ev.createdAt),
        kind: ev.type,
        channel: 'EMAIL',
        contact: tok.recipient,
        accountId: tok.accountId ?? ev.accountId,
        refId: ev.trackToken ?? ev.id,
        status: ev.type,
        detail: [ev.detail, ev.smtpCode ? `smtp ${ev.smtpCode}` : ''].filter(Boolean).join(' · ') || null,
      });
    }
  }

  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const truncated = items.length > cap;
  return { items: items.slice(0, cap), truncated };
}
