// ── Discovery Job Service (对标 Revor revor_get_job / revor_cancel_job) ──────
// Generic async-job status retrieval and cancellation shared by all discovery
// operations (webset preparation, public research, contact finding).

import { prisma } from '../../db/prisma.js';
import { Prisma } from '@prisma/client';
import type { DiscoveryJob } from '@prisma/client';

export interface JobResult {
  ok: boolean;
  item: {
    id: string;
    kind: string;
    status: DiscoveryJob['status'];
    input: Record<string, unknown>;
    result: Record<string, unknown> | null;
    billing: Record<string, unknown> | null;
    error: { code: string; message: string } | null;
    nextAction: { retry_after_ms: number; arguments: { job_id: string } } | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
  };
}

export async function getDiscoveryJob(tenantId: string, jobId: string): Promise<JobResult | null> {
  const job = await prisma.discoveryJob.findFirst({
    where: { id: jobId, tenantId },
  });
  if (!job) return null;

  const isTerminal = job.status === 'SUCCEEDED' || job.status === 'FAILED' || job.status === 'CANCELLED';
  return {
    ok: true,
    item: {
      id: job.id,
      kind: job.kind,
      status: job.status,
      input: (job.input as Record<string, unknown>) ?? {},
      result: (job.result as Record<string, unknown>) ?? null,
      billing: (job.billing as Record<string, unknown>) ?? null,
      error: (job.error as JobResult['item']['error']) ?? null,
      nextAction: isTerminal ? null : (job.nextAction as JobResult['item']['nextAction']) ?? null,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
    },
  };
}

export async function cancelDiscoveryJob(
  tenantId: string,
  jobId: string,
): Promise<{ ok: boolean; item: { id: string; status: string } } | { ok: boolean; error: { code: string; message: string } }> {
  const job = await prisma.discoveryJob.findFirst({
    where: { id: jobId, tenantId },
  });
  if (!job) {
    return { ok: false, error: { code: 'job_not_found', message: 'The job was not found' } };
  }

  // Revor: cancellation only guaranteed for queued jobs; a running job may have
  // already performed a side effect → return job_already_running.
  if (job.status === 'RUNNING') {
    return { ok: false, error: { code: 'job_already_running', message: 'The job is running and cannot be guaranteed cancelled. Keep the job ID and poll it to a final state.' } };
  }
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
    return { ok: true, item: { id: job.id, status: job.status } };
  }

  await prisma.discoveryJob.update({
    where: { id: jobId },
    data: { status: 'CANCELLED', finishedAt: new Date(), nextAction: Prisma.DbNull },
  });
  return { ok: true, item: { id: jobId, status: 'CANCELLED' } };
}
