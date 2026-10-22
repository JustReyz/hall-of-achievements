import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonResponse } from '@/lib/auth/api-guard';
import { getVapidKeys } from '@/lib/push/sender';

/**
 * GET /api/push/vapid-public-key - Returns public VAPID key to authenticated owner.
 */
export async function GET(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const vapid = getVapidKeys();
  return jsonResponse({
    publicKey: vapid.publicKey,
  });
}
