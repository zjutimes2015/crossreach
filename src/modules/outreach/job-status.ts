// ── Job Status Service (对标 Revor GET /api/v1/outreach/jobs/{id}) ──────────
// Retrieves the status and result of an outreach task.

import { prisma } from '../../db/prisma.js';
import type { OutreachJob } from '@prisma/client';

export interface JobStatusResponse {
  ok: boolean;
  requestId: string;
  item: {
    id: string;
    status: OutreachJob['status'];
    action: string;
    channel: OutreachJob['channel'];
    scheduledAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    attemptCount: number;
    nextAttemptAt: string | null;
    result: Record<string, unknown> | null;
    error: { code: string; message: string; retryable: boolean } | null;
  };
}

function formatAction(action: OutreachJob['action']): string {
  return action === 'OUTREACH_DISPATCH'
    ? 'outreach.dispatch'
    : 'outreach.linkedin.post_like';
}

export async function getJobStatus(
  tenantId: string,
  jobId: string,
): Promise<JobStatusResponse | null> {
  const job = await prisma.outreachJob.findFirst({
    where: { id: jobId, tenantId },
  });

  if (!job) return null;

  return {
    ok: true,
    requestId: `req_${job.id.slice(-8)}`,
    item: {
      id: job.id,
      status: job.status,
      action: formatAction(job.action),
      channel: job.channel,
      scheduledAt: job.scheduledAt?.toISOString() ?? null,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      attemptCount: job.attemptCount,
      nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
      result: (job.result as Record<string, unknown>) ?? null,
      error: (job.error as JobStatusResponse['item']['error']) ?? null,
    },
  };
}
