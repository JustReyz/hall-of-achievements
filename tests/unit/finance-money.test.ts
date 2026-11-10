import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from '@/lib/finance/money';

describe('finance money', () => {
  it('preserves decimal values beyond the safe integer range', () => {
    expect(formatMoney(parseMoney('9999999999999999.99'))).toBe('9999999999999999.99');
    expect(parseMoney('0.01')).toBe(1n);
    expect(formatMoney(-105n)).toBe('-1.05');
  });

  it('rejects zero, floating-point inputs, exponents and excess precision', () => {
    for (const value of ['0', '0.00', '1.001', '1e3', '-1', '01', 1.5, '10000000000000000']) {
      expect(() => parseMoney(value)).toThrow();
    }
  });
});
