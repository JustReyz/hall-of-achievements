import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { createSource, FinanceLedgerError, listSources, readFinanceBody, requireUuid } from '@/lib/finance/ledger';

function errorResponse(error: unknown) {
  return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error);
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireFinanceUser(request);
    const groupId = requireUuid(request.nextUrl.searchParams.get('groupId'), 'groupId');
    return jsonResponse({ sources: await listSources(await getDb(), userId, groupId) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireFinanceUser(request);
    const source = await createSource(await getDb(), context, await readFinanceBody(request));
    return jsonResponse({ source }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
