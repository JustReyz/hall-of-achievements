import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { FinanceLedgerError, readFinanceBody } from '@/lib/finance/ledger';
import { deleteNote, updateNote } from '@/lib/finance/planner';

function errorResponse(error: unknown) { return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error); }
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: NextRequest, context: Context) {
  try { const user = await requireFinanceUser(request); const { id } = await context.params; return jsonResponse({ note: await updateNote(await getDb(), user, id, await readFinanceBody(request)) }); }
  catch (error) { return errorResponse(error); }
}
export async function DELETE(request: NextRequest, context: Context) {
  try { const user = await requireFinanceUser(request); const { id } = await context.params; return jsonResponse({ note: await deleteNote(await getDb(), user, id) }); }
  catch (error) { return errorResponse(error); }
}
