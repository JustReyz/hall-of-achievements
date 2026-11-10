import { describe, expect, it } from 'vitest';
import { hashFinancePassword, verifyFinancePassword } from '@/lib/finance/password';

describe('finance password', () => {
  it('uses a unique salt and verifies only the original password', async () => {
    const first = await hashFinancePassword('a suitable test password');
    const second = await hashFinancePassword('a suitable test password');
    expect(first).not.toBe(second);
    expect(await verifyFinancePassword('a suitable test password', first)).toBe(true);
    expect(await verifyFinancePassword('another test password', first)).toBe(false);
    expect(await verifyFinancePassword('a suitable test password', 'scrypt$bad$bad')).toBe(false);
  });
});
