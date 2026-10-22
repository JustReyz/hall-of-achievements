import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { getStorageQuotaStats } from '@/lib/storage/quota';

export async function GET(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  try {
    const db = await getDb();
    const stats = await getStorageQuotaStats(db);
    return jsonResponse(stats);
  } catch (err) {
    console.error('[GET /api/storage/quota ERROR]', err);
    return jsonError('Failed to fetch storage quota stats', 500, 'DATABASE_ERROR');
  }
}
