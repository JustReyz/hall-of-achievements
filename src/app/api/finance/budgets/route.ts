import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { FinanceLedgerError, getGroupBudget, readFinanceBody, requireUuid, setGroupBudget } from '@/lib/finance/ledger';

function errorResponse(error: unknown) {
  return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error);
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireFinanceUser(request);
    const groupId = requireUuid(request.nextUrl.searchParams.get('groupId'), 'groupId');
    return jsonResponse({ budget: await getGroupBudget(await getDb(), userId, groupId) });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: NextRequest) {
  try {
    const context = await requireFinanceUser(request);
    return jsonResponse({ budget: await setGroupBudget(await getDb(), context, await readFinanceBody(request)) });
  } catch (error) { return errorResponse(error); }
}
