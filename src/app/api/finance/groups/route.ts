import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { createGroup, FinanceLedgerError, listGroups, readFinanceBody } from '@/lib/finance/ledger';

function errorResponse(error: unknown) {
  return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error);
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireFinanceUser(request);
    return jsonResponse({ groups: await listGroups(await getDb(), userId) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireFinanceUser(request);
    const body = await readFinanceBody(request);
    return jsonResponse({ group: await createGroup(await getDb(), context, body) }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
