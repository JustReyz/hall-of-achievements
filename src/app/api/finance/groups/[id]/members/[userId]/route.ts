import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeErrorResponse, requireFinanceUser } from '@/lib/finance/auth';
import { FinanceLedgerError, readFinanceBody, removeGroupMember, updateGroupMemberRole } from '@/lib/finance/ledger';

function errorResponse(error: unknown) { return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error); }
type Context = { params: Promise<{ id: string; userId: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const user = await requireFinanceUser(request);
    const { id: groupId, userId } = await context.params;
    const { role } = await readFinanceBody(request);
    return jsonResponse({ member: await updateGroupMemberRole(await getDb(), user, groupId, userId, role) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const user = await requireFinanceUser(request);
    const { id: groupId, userId } = await context.params;
    return jsonResponse({ member: await removeGroupMember(await getDb(), user, groupId, userId) });
  } catch (error) { return errorResponse(error); }
}
