import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { deleteTransaction, FinanceLedgerError, readFinanceBody, requireUuid, updateTransaction } from '@/lib/finance/ledger';

type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error);
}

function requireExpectedActor(request: NextRequest, userId: string): void {
  let actor: string;
  try { actor = requireUuid(request.headers.get('X-Finance-Actor'), 'X-Finance-Actor'); }
  catch { throw new FinanceLedgerError('FINANCE_ACTOR_CHANGED', 'Finance account changed. Reload before continuing.', 409); }
  if (actor !== userId.toLowerCase()) throw new FinanceLedgerError('FINANCE_ACTOR_CHANGED', 'Finance account changed. Reload before continuing.', 409);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireFinanceUser(request);
    requireExpectedActor(request, session.userId);
    const { id } = await context.params;
    return jsonResponse({ transaction: await updateTransaction(await getDb(), session, id, await readFinanceBody(request)) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireFinanceUser(request);
    requireExpectedActor(request, session.userId);
    const { id } = await context.params;
    return jsonResponse({ transaction: await deleteTransaction(await getDb(), session, id) });
  } catch (error) { return errorResponse(error); }
}
