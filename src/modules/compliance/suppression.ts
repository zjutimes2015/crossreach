// ── Compliance: suppression registry (外呼合规证据链 — 核心) ─────────────────
// Every outbound path (email pipeline, outreach dispatch, WhatsApp campaigns,
// sequences) consults this registry before sending and HARD-BLOCKS suppressed
// recipients. Entries are auto-added by the feedback path (unsubscribe click,
// spam complaint, hard bounce) and manually through the compliance API.
//
// Contact identities are normalized so the same human is matched across
// formats: emails are lower-cased, phone numbers are reduced to digits (with a
// last-9-digit fallback to survive country-code mismatches), LinkedIn profile
// URLs are trimmed of trailing slashes.

import type { Suppression, SuppressionChannel, SuppressionReason } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

export type { SuppressionChannel, SuppressionReason };

// ── Pure normalization (unit-testable, no store) ───────────────────────────

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

export function normalizeProfileUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Normalize a raw contact string for the given channel before storage/match. */
export function normalizeContact(channel: SuppressionChannel, raw: string): string {
  const value = String(raw ?? '').trim();
  if (channel === 'EMAIL') return normalizeEmail(value);
  if (channel === 'WHATSAPP') return normalizePhone(value);
  return normalizeProfileUrl(value);
}

export interface SuppressionLike {
  channel: SuppressionChannel;
  contact: string;
}

/**
 * Match a raw outbound contact against a set of suppression rows.
 * Equality after normalization first; then, for WhatsApp, a last-9-digit
 * suffix match in either direction so "+86 138 0000 0001" and "13800000001"
 * hit the same entry when one side carries the country code.
 */
export function findSuppressionMatch(
  entries: SuppressionLike[],
  channel: SuppressionChannel,
  rawContact: string,
): SuppressionLike | null {
  if (!rawContact) return null;
  const normalized = normalizeContact(channel, rawContact);
  if (!normalized) return null;

  for (const e of entries) {
    if (e.channel === channel && e.contact === normalized) return e;
  }

  if (channel === 'WHATSAPP') {
    const digits = normalizePhone(normalized);
    if (digits.length >= 9) {
      const suffix = digits.slice(-9);
      for (const e of entries) {
        if (e.channel !== 'WHATSAPP') continue;
        const other = e.contact;
        if (other.length >= 9 && (other.slice(-9) === suffix || digits.endsWith(other.slice(-9)))) {
          return e;
        }
      }
    }
  }

  return null;
}

// ── Store helpers ─────────────────────────────────────────────────────────

export type SuppressionEntry = Suppression;

/**
 * Is this contact currently blocked for the tenant/channel?
 * Returns the matching active entry (used by the send gates to build the
 * "blocked + refund" evidence) or null when sending is allowed.
 */
export async function isSuppressed(
  tenantId: string,
  channel: SuppressionChannel,
  rawContact: string,
): Promise<Suppression | null> {
  const entries = await prisma.suppression.findMany({
    where: { tenantId, channel, active: true },
    orderBy: { createdAt: 'desc' },
  });
  return (findSuppressionMatch(entries, channel, rawContact) as Suppression | null) ?? null;
}

export interface AddSuppressionInput {
  tenantId: string;
  channel: SuppressionChannel;
  contact: string;
  reason: SuppressionReason;
  source?: string;
  note?: string;
}

export interface AddSuppressionResult {
  created: boolean;
  entry: Suppression;
}

/**
 * Add (or reactivate) a suppression entry. Idempotent per [tenant, channel,
 * contact]: a re-add after a manual removal flips the row back to active and
 * KEEPS the original createdAt so the first opt-out date remains the audit
 * basis; reason/source are refreshed to the latest occurrence.
 */
export async function addSuppression(input: AddSuppressionInput): Promise<AddSuppressionResult> {
  const contact = normalizeContact(input.channel, input.contact);
  if (!contact) {
    throw new Error(`Cannot suppress an empty contact for channel ${input.channel}`);
  }

  const entry = await prisma.suppression.upsert({
    where: {
      tenantId_channel_contact: {
        tenantId: input.tenantId,
        channel: input.channel,
        contact,
      },
    },
    create: {
      tenantId: input.tenantId,
      channel: input.channel,
      contact,
      reason: input.reason,
      source: input.source ?? null,
      note: input.note ?? null,
      active: true,
    },
    update: {
      active: true,
      removedAt: null,
      reason: input.reason,
      source: input.source ?? null,
      note: input.note ?? null,
    },
  });

  return { created: false, entry };
}

export interface ListSuppressionsOptions {
  channel?: SuppressionChannel;
  contact?: string;
  reason?: SuppressionReason;
  includeInactive?: boolean;
  limit?: number;
}

/**
 * List suppression history for the tenant. `contact` matches active+gates
 * semantics: equality (or WhatsApp last-9 suffix) — inactive rows are matched
 * on the same normalized value so operators can find and re-activate them.
 */
export async function listSuppressions(
  tenantId: string,
  opts: ListSuppressionsOptions = {},
): Promise<Suppression[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const channel = opts.channel;

  // When a contact filter is given we pull the (small) candidate set and match
  // in JS so suffix matching stays identical to the send gate.
  const rows = await prisma.suppression.findMany({
    where: {
      tenantId,
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.includeInactive ? {} : { active: true }),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.contact ? 1000 : limit,
  });

  if (!opts.contact) return rows.slice(0, limit);

  const match = (e: Suppression) =>
    opts.contact
      ? findSuppressionMatch(
          [{ channel: e.channel, contact: e.contact }],
          channel ?? e.channel,
          opts.contact,
        ) !== null
      : true;

  return rows.filter(match).slice(0, limit);
}

/** Deactivate (soft-delete) an entry — stops the gate, keeps the audit row. */
export async function removeSuppression(
  tenantId: string,
  suppressionId: string,
  by?: string,
): Promise<Suppression | null> {
  const existing = await prisma.suppression.findFirst({
    where: { id: suppressionId, tenantId },
  });
  if (!existing || !existing.active) return existing ?? null;

  return prisma.suppression.update({
    where: { id: suppressionId },
    data: { active: false, removedAt: new Date(), note: (by ? `removed by ${by}; ` : 'removed; ') + (existing.note ?? '') },
  });
}

/** Human-readable one-liner used in gate logs + job evidence. */
export function suppressionReasonText(entry: Pick<Suppression, 'reason' | 'contact' | 'createdAt'>): string {
  const date = entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt);
  return `contact suppressed (${entry.reason.toLowerCase().replace(/_/g, ' ')}) since ${date.toISOString()}`;
}
