// ── Compliance errors ────────────────────────────────────────────────────────
// Thrown by the send gates when a recipient is on the suppression registry.
// The outreach executor maps it onto a FAILED job whose error payload carries
// the matched suppression row (reason, suppressed-since, id) as retrievable
// evidence, then refunds the pre-charged credit.

import type { Suppression } from '@prisma/client';
import { suppressionReasonText } from './suppression.js';

export class ComplianceBlockedError extends Error {
  readonly code = 'suppressed_recipient';

  constructor(public suppression: Suppression) {
    super(suppressionReasonText(suppression));
    this.name = 'ComplianceBlockedError';
  }

  get retryable(): boolean {
    return false;
  }
}

export function isComplianceBlocked(err: unknown): err is ComplianceBlockedError {
  return err instanceof ComplianceBlockedError;
}
