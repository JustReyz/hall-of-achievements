import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { FinanceLedgerError, readFinanceBody } from '@/lib/finance/ledger';
import { createScheduledTask, listScheduledTasks } from '@/lib/finance/planner';
function errorResponse(error: unknown) { return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error); }
export async function GET(request: NextRequest) {
  try { const user = await requireFinanceUser(request); return jsonResponse({ tasks: await listScheduledTasks(await getDb(), user.userId, request.nextUrl.searchParams.get('groupId')) }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
  try { const user = await requireFinanceUser(request); return jsonResponse({ task: await createScheduledTask(await getDb(), user, await readFinanceBody(request)) }, { status: 201 }); }
  catch (error) { return errorResponse(error); }
}
