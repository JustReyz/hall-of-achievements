import type { NextRequest } from 'next/server';
import { jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { requireFinanceUser } from '@/lib/finance/auth';
import { listFinanceDevices, registerFinanceDevice } from '@/lib/finance/push';
import { pushErrorResponse, readPushBody } from '@/lib/finance/push-http';

export async function GET(request: NextRequest) {
  try { const user = await requireFinanceUser(request); return jsonResponse({ devices: await listFinanceDevices(await getDb(), user.userId) }); }
  catch (error) { return pushErrorResponse(error); }
}
export async function POST(request: NextRequest) {
  try { const user = await requireFinanceUser(request); return jsonResponse({ device: await registerFinanceDevice(await getDb(), user, await readPushBody(request)) }, { status: 201 }); }
  catch (error) { return pushErrorResponse(error); }
}
