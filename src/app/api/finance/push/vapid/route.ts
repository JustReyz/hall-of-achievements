import type { NextRequest } from 'next/server';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { requireFinanceUser } from '@/lib/finance/auth';
import { pushErrorResponse } from '@/lib/finance/push-http';
import { getVapidKeys } from '@/lib/push/sender';

export async function GET(request: NextRequest) {
  try {
    await requireFinanceUser(request);
    try { return jsonResponse({ publicKey: getVapidKeys().publicKey }); }
    catch { return jsonError('Push notifications are not configured.', 503, 'PUSH_NOT_CONFIGURED'); }
  }
  catch (error) { return pushErrorResponse(error); }
}
