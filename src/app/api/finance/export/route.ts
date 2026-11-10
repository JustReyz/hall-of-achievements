import type { NextRequest } from 'next/server';
import { and, desc, eq, gte, lte, isNull } from 'drizzle-orm';
import { jsonError } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeGroupMembers, financeSources, financeTransactions, financeWallets } from '@/lib/db/schema';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { financeCsv } from '@/lib/finance/csv';
import { FinanceLedgerError, requireUuid } from '@/lib/finance/ledger';
import { validateCalendarDate } from '@/lib/validation/achievement';

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireFinanceUser(request);
    const groupId = requireUuid(request.nextUrl.searchParams.get('groupId'), 'groupId');
    const from = request.nextUrl.searchParams.get('from');
    const to = request.nextUrl.searchParams.get('to');
    if ((from && !validateCalendarDate(from)) || (to && !validateCalendarDate(to)) || (from && to && from > to)) {
      throw new FinanceLedgerError('INVALID_INPUT', 'Date range is invalid.', 400);
    }
    const db = await getDb();
    const [membership] = await db.select({ groupId: financeGroupMembers.groupId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId)));
    if (!membership) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
    const conditions = [eq(financeWallets.groupId, groupId), eq(financeGroupMembers.userId, userId), isNull(financeTransactions.deletedAt)];
    if (from) conditions.push(gte(financeTransactions.transactionDate, from));
    if (to) conditions.push(lte(financeTransactions.transactionDate, to));
    const rows = await db.select({
      date: financeTransactions.transactionDate,
      wallet: financeWallets.name,
      type: financeTransactions.type,
      category: financeTransactions.category,
      source: financeSources.name,
      amount: financeTransactions.amount,
      notes: financeTransactions.note,
    }).from(financeTransactions)
      .innerJoin(financeWallets, eq(financeWallets.id, financeTransactions.walletId))
      .innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeWallets.groupId), eq(financeGroupMembers.userId, userId)))
      .leftJoin(financeSources, eq(financeSources.id, financeTransactions.sourceId))
      .where(and(...conditions)).orderBy(desc(financeTransactions.transactionDate), desc(financeTransactions.createdAt));
    const body = `\uFEFF${financeCsv(rows)}`;
    return new Response(body, { headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="hall-finance-${from ?? 'all'}-${to ?? 'all'}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    if (error instanceof FinanceLedgerError) return jsonError(error.message, error.status, error.code);
    return financeErrorResponse(error);
  }
}
