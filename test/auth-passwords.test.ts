import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/modules/auth/passwords.js';

describe('password hashing (bcryptjs)', () => {
  it('verifies the correct password against its hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toBeTruthy();
    // Never store the plaintext anywhere near the hash
    expect(hash).not.toContain('correct');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right-password');
    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('salts every hash so identical inputs differ', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
    await expect(verifyPassword('same-password', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password', b)).resolves.toBe(true);
  });

  it('returns false for a non-bcrypt stored value instead of throwing', async () => {
    await expect(verifyPassword('anything', 'plain-text-leak')).resolves.toBe(false);
  });
});
