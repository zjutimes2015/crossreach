// ── Auth errors ──────────────────────────────────────────────────────────────
// statusCode is the HTTP status; code is a stable machine-readable string the
// dashboard can branch on.

export class AuthError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
