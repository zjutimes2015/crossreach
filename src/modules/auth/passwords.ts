// ── Password hashing ────────────────────────────────────────────────────────
// bcrypt with a work factor of 10. Never store or compare plaintext.

import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
