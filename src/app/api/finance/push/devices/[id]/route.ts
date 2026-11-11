import type { NextRequest } from 'next/server';
import { jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { requireFinanceUser } from '@/lib/finance/auth';
import { removeFinanceDevice } from '@/lib/finance/push';
import { pushErrorResponse } from '@/lib/finance/push-http';

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try { const user = await requireFinanceUser(request); const { id } = await context.params; return jsonResponse({ device: await removeFinanceDevice(await getDb(), user, id) }); }
  catch (error) { return pushErrorResponse(error); }
}
