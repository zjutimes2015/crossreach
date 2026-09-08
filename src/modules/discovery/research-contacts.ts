// ── Research + Contacts Service (对标 Revor revor_research_public_web / find_contacts) ─
// Both operations use the async-job pattern with a sync-wait window. Because
// the stub provider resolves fast, the job completes synchronously and the
// result is returned inline; the persisted job record still carries billing
// and is pollable via revor_get_job.

import { prisma } from '../../db/prisma.js';
import { Prisma } from '@prisma/client';
import { logger } from '../../utils/logger.js';
import { stubProvider } from './provider.js';

export class DiscoveryError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

// ── Public web research ──────────────────────────────────────────────────────

export interface ResearchRequest {
  queries: string[];
  searchLimit?: number;
  category?: string;
  includeDomains?: string[];
  userLocation?: string;
}

export interface ResearchResponse {
  ok: boolean;
  item: {
    id: string;
    kind: 'PUBLIC_RESEARCH';
    status: 'SUCCEEDED';
    findings: unknown[];
    billing: { chargedCredits: number };
  };
  nextAction: null;
}

export async function runResearch(tenantId: string, req: ResearchRequest): Promise<ResearchResponse> {
  if (!req.queries?.length) {
    throw new DiscoveryError(400, 'queries_required', 'At least one research query is required');
  }
  if (req.queries.length > 2) {
    throw new DiscoveryError(400, 'too_many_queries', 'Provide at most two focused research questions');
  }
  const searchLimit = Math.min(req.searchLimit ?? 5, 10);

  const job = await prisma.discoveryJob.create({
    data: {
      tenantId,
      kind: 'PUBLIC_RESEARCH',
      status: 'RUNNING',
      startedAt: new Date(),
      input: req as object,
    },
  });

  try {
    const findings = await stubProvider.researchPublicWeb(req.queries, searchLimit, {
      category: req.category,
      includeDomains: req.includeDomains,
      userLocation: req.userLocation,
    });

    const chargedCredits = findings.length * 2;
    await prisma.discoveryJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        result: { findings } as object,
        billing: { chargedCredits } as object,
        nextAction: Prisma.DbNull,
      },
    });

    logger.info({ jobId: job.id, findings: findings.length }, 'Public research succeeded');
    return { ok: true, item: { id: job.id, kind: 'PUBLIC_RESEARCH', status: 'SUCCEEDED', findings, billing: { chargedCredits } }, nextAction: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'research failed';
    await prisma.discoveryJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date(), error: { code: 'research_failed', message } as object },
    });
    throw new DiscoveryError(500, 'research_failed', message);
  }
}

// ── Find contacts (decision-makers by verified domain) ──────────────────────

export interface ContactsRequest {
  domain: string;
  positions?: string[];
  limit?: number;
  locale?: 'en' | 'zh';
}

export interface ContactsResponse {
  ok: boolean;
  item: {
    id: string;
    kind: 'FIND_CONTACTS';
    status: 'SUCCEEDED';
    domain: string;
    contacts: unknown[];
    billing: { chargedCredits: number };
  };
  nextAction: null;
}

export async function findContacts(tenantId: string, req: ContactsRequest): Promise<ContactsResponse> {
  if (!req.domain?.trim()) {
    throw new DiscoveryError(400, 'domain_required', 'A verified company website domain is required');
  }
  // Reject search-result URLs (Revor: domain must be a bare company domain)
  if (/^https?:\/\//i.test(req.domain) || req.domain.includes('/')) {
    throw new DiscoveryError(400, 'invalid_domain', 'Provide the company website domain, not a search-results URL');
  }
  const limit = Math.min(req.limit ?? 10, 10);

  const job = await prisma.discoveryJob.create({
    data: {
      tenantId,
      kind: 'FIND_CONTACTS',
      status: 'RUNNING',
      startedAt: new Date(),
      input: req as object,
    },
  });

  try {
    const contacts = await stubProvider.findContacts(req.domain, req.positions ?? [], limit);
    const chargedCredits = contacts.length * 2;

    await prisma.discoveryJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        result: { domain: req.domain, contacts } as object,
        billing: { chargedCredits } as object,
        nextAction: Prisma.DbNull,
      },
    });

    logger.info({ jobId: job.id, domain: req.domain, contacts: contacts.length }, 'Find contacts succeeded');
    return { ok: true, item: { id: job.id, kind: 'FIND_CONTACTS', status: 'SUCCEEDED', domain: req.domain, contacts, billing: { chargedCredits } }, nextAction: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'contact lookup failed';
    await prisma.discoveryJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date(), error: { code: 'contacts_failed', message } as object },
    });
    throw new DiscoveryError(500, 'contacts_failed', message);
  }
}
