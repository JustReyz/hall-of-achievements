import { describe, expect, it } from 'vitest';
import { financeCsv } from '@/lib/finance/csv';

describe('finance CSV export', () => {
  it('quotes fields and neutralizes spreadsheet formulas', () => {
    expect(financeCsv([{ date: '2026-11-10', wallet: 'Family, Main', type: 'income', category: '=HYPERLINK("x")', source: null, amount: '10.00', notes: 'say "hi"' }]))
      .toBe('date,wallet,type,category,source,amount,notes\r\n"2026-11-10","Family, Main","income","\'=HYPERLINK(""x"")","","10.00","say ""hi"""');
  });
});
