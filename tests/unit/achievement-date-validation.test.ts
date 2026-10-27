import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  validateCalendarDate,
  validateCompletionDate,
  validateDateRange,
} from '@/lib/validation/achievement';

afterEach(() => vi.useRealTimers());

describe('achievement date validation', () => {
  it('accepts a leap day and rejects impossible or malformed dates', () => {
    expect(validateCalendarDate('2024-02-29')).toBe('2024-02-29');
    for (const value of [
      '2025-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-1-01',
      '2026-10-01T00:00:00Z',
      null,
    ]) {
      expect(() => validateCalendarDate(value)).toThrow();
    }
  });

  it('normalizes empty and open bounds without rejecting future filters', () => {
    expect(validateDateRange(null, ' ')).toEqual({ from: '', to: '' });
    expect(validateDateRange(' 2026-10-01 ', '')).toEqual({ from: '2026-10-01', to: '' });
    expect(validateDateRange('', '2099-12-31')).toEqual({ from: '', to: '2099-12-31' });
    expect(validateDateRange('2026-10-01', '2026-10-01')).toEqual({
      from: '2026-10-01',
      to: '2026-10-01',
    });
  });

  it('rejects reversed ranges', () => {
    expect(() => validateDateRange('2026-10-02', '2026-10-01')).toThrow(
      'Completed from must not be after Completed through.'
    );
  });

  it('preserves timezone-aware future-date rejection for writes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T18:00:00Z'));
    expect(validateCompletionDate('2026-10-28', 'Asia/Makassar')).toBe('2026-10-28');
    expect(() => validateCompletionDate('2026-10-28', 'UTC')).toThrow();
    expect(() => validateCompletionDate('2026-10-28', 'Invalid/Timezone')).toThrow();
  });
});
