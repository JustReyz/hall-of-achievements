import type { NextRequest } from 'next/server';
import { jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { requireFinanceUser } from '@/lib/finance/auth';
import { sendFinanceReminder } from '@/lib/finance/push';
import { pushErrorResponse, readPushBody } from '@/lib/finance/push-http';

export async function POST(request: NextRequest) {
  try { const user = await requireFinanceUser(request); return jsonResponse(await sendFinanceReminder(await getDb(), user, await readPushBody(request))); }
  catch (error) { return pushErrorResponse(error); }
}
