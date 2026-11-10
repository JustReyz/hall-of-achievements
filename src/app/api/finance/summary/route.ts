import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { FinanceLedgerError, getGroupSummary, requireUuid } from '@/lib/finance/ledger';
import { validateCalendarDate } from '@/lib/validation/achievement';

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireFinanceUser(request);
    const groupId = requireUuid(request.nextUrl.searchParams.get('groupId'), 'groupId');
    const allTimeParam = request.nextUrl.searchParams.get('allTime');
    if (allTimeParam !== null && allTimeParam !== 'true' && allTimeParam !== 'false')
      throw new FinanceLedgerError('INVALID_INPUT', 'allTime must be true or false.', 400);
    const allTime = allTimeParam === 'true';
    let start = request.nextUrl.searchParams.get('start');
    let end = request.nextUrl.searchParams.get('end');
    if (allTime && (start || end)) throw new FinanceLedgerError('INVALID_INPUT', 'Date range cannot be combined with allTime.', 400);
    if (start || end) {
      if (!start || !end) throw new FinanceLedgerError('INVALID_INPUT', 'Provide both start and end dates.', 400);
      try { start = validateCalendarDate(start); end = validateCalendarDate(end); }
      catch { throw new FinanceLedgerError('INVALID_DATE', 'Date range must use valid YYYY-MM-DD dates.', 400); }
      if (start > end) throw new FinanceLedgerError('INVALID_DATE', 'Start date must not be after end date.', 400);
    } else if (!allTime) {
      const now = new Date();
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
      end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    } else { start = null; end = null; }
    return jsonResponse({ summary: await getGroupSummary(await getDb(), userId, groupId, start, end) });
  } catch (error) {
    return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error);
  }
}
