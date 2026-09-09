// ── Compliance routes (外呼合规证据链) ───────────────────────────────────────
// GET    /api/v1/compliance/suppressions            — suppression registry
// POST   /api/v1/compliance/suppressions            — add (manual or re-add)
// DELETE /api/v1/compliance/suppressions/:id        — 申诉解除 (soft delete)
// GET    /api/v1/compliance/evidence                — per-recipient timeline
// GET    /api/v1/compliance/evidence/export         — the same as CSV
//
// Registered INSIDE the /api tenantMiddleware scope: x-api-key required.
// Sends are gated at the pipeline level (email send, outreach dispatch,
// campaigns, sequences); this surface is for review + manual control.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { SuppressionChannel, SuppressionReason } from '@prisma/client';
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
} from '../../modules/compliance/suppression.js';
import {
  buildEvidenceTimeline,
  renderCsv,
  type EvidenceItem,
} from '../../modules/compliance/evidence.js';

const CHANNELS = ['EMAIL', 'WHATSAPP', 'LINKEDIN'] as const;
const REASONS = ['UNSUBSCRIBED', 'COMPLAINED', 'BOUNCED_HARD', 'MANUAL'] as const;

const addSuppressionSchema = z.object({
  channel: z.enum(CHANNELS),
  contact: z.string().trim().min(1).max(320),
  reason: z.enum(REASONS).default('MANUAL'),
  note: z.string().trim().max(500).optional(),
});

const boolFromQuery = (v: unknown): boolean => v === 'true' || v === '1';

export async function complianceRoutes(server: FastifyInstance) {
  // ── GET /api/v1/compliance/suppressions ─────────────────────────────────
  server.get('/v1/compliance/suppressions', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const q = req.query as {
      channel?: string;
      reason?: string;
      contact?: string;
      includeInactive?: string;
      limit?: string;
    };

    const channel = (CHANNELS as readonly string[]).includes(q.channel ?? '')
      ? (q.channel as SuppressionChannel)
      : undefined;
    const reason = (REASONS as readonly string[]).includes(q.reason ?? '')
      ? (q.reason as SuppressionReason)
      : undefined;
    const limit = q.limit ? Math.max(1, Math.min(500, Number(q.limit) || 100)) : 100;

    const suppressions = await listSuppressions(tenant.id, {
      channel,
      reason,
      contact: q.contact,
      includeInactive: boolFromQuery(q.includeInactive),
      limit,
    });

    return reply.send({
      ok: true,
      count: suppressions.length,
      suppressions: suppressions.map((s) => ({
        id: s.id,
        channel: s.channel,
        contact: s.contact,
        reason: s.reason,
        source: s.source,
        note: s.note,
        active: s.active,
        createdAt: s.createdAt.toISOString(),
        removedAt: s.removedAt?.toISOString() ?? null,
      })),
    });
  });

  // ── POST /api/v1/compliance/suppressions ────────────────────────────────
  server.post('/v1/compliance/suppressions', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const parsed = addSuppressionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        ok: false,
        error: { code: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
      });
    }

    const { entry } = await addSuppression({
      tenantId: tenant.id,
      channel: parsed.data.channel,
      contact: parsed.data.contact,
      reason: parsed.data.reason,
      source: 'api',
      note: parsed.data.note,
    });

    return reply.send({
      ok: true,
      suppression: {
        id: entry.id,
        channel: entry.channel,
        contact: entry.contact,
        reason: entry.reason,
        source: entry.source,
        note: entry.note,
        active: entry.active,
        createdAt: entry.createdAt.toISOString(),
        removedAt: null,
      },
    });
  });

  // ── DELETE /api/v1/compliance/suppressions/:id (申诉解除) ───────────────
  server.delete('/v1/compliance/suppressions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };

    const removed = await removeSuppression(tenant.id, id, 'api');
    if (!removed) {
      return reply.status(404).send({
        ok: false,
        error: { code: 'suppression_not_found', message: 'Suppression entry not found or already removed' },
      });
    }
    return reply.send({ ok: true, suppressionId: removed.id, active: removed.active });
  });

  // ── GET /api/v1/compliance/evidence ─────────────────────────────────────
  server.get('/v1/compliance/evidence', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const result = await readEvidenceQuery(tenant.id, req.query as Record<string, string>);
    return reply.send({ ok: true, ...result });
  });

  // ── GET /api/v1/compliance/evidence/export (CSV) ────────────────────────
  server.get('/v1/compliance/evidence/export', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const result = await readEvidenceQuery(tenant.id, req.query as Record<string, string>, 5000);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="crossreach-compliance-${stamp}.csv"`)
      .send(renderCsv(result.items));
  });
}

// ── Shared query parsing (evidence list + CSV export) ─────────────────────

async function readEvidenceQuery(
  tenantId: string,
  q: Record<string, string>,
  limit?: number,
): Promise<{ truncated: boolean; count: number; items: EvidenceItem[] }> {
  const { items, truncated } = await buildEvidenceTimeline(tenantId, {
    channel: (CHANNELS as readonly string[]).includes(q.channel ?? '')
      ? (q.channel as SuppressionChannel)
      : undefined,
    contact: q.contact?.trim() || undefined,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
    limit: limit ?? (q.limit ? Number(q.limit) : undefined),
  });
  return { truncated, count: items.length, items };
}
