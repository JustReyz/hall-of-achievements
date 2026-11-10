import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { createTransaction, FinanceLedgerError, findTransactionByRequestKey, listTransactions, readFinanceBody, requireUuid } from '@/lib/finance/ledger';

function errorResponse(error: unknown) {
  return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error);
}

function requireExpectedActor(request: NextRequest, userId: string): void {
  let expected: string;
  try { expected = requireUuid(request.headers.get('X-Finance-Actor'), 'X-Finance-Actor'); }
  catch { throw new FinanceLedgerError('FINANCE_ACTOR_CHANGED', 'Finance account changed. Reload before continuing.', 409); }
  if (expected !== userId.toLowerCase()) {
    throw new FinanceLedgerError('FINANCE_ACTOR_CHANGED', 'Finance account changed. Reload before continuing.', 409);
  }
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireFinanceUser(request);
    const requestKey = request.nextUrl.searchParams.get('requestKey');
    if (requestKey !== null) {
      requireExpectedActor(request, userId);
      if (request.nextUrl.searchParams.has('walletId')) throw new FinanceLedgerError('INVALID_INPUT', 'Choose requestKey or walletId.', 400);
      return jsonResponse({ transaction: await findTransactionByRequestKey(await getDb(), userId, requireUuid(requestKey, 'requestKey')) });
    }
    const walletId = requireUuid(request.nextUrl.searchParams.get('walletId'), 'walletId');
    const rows = await listTransactions(await getDb(), userId, walletId);
    return jsonResponse({ transactions: rows.slice(0, 200), hasMore: rows.length > 200 });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireFinanceUser(request);
    requireExpectedActor(request, context.userId);
    const body = await readFinanceBody(request);
    const transaction = await createTransaction(await getDb(), context, request.headers.get('Idempotency-Key'), body);
    return jsonResponse({ transaction }, { status: transaction.replayed ? 200 : 201 });
  } catch (error) { return errorResponse(error); }
}
