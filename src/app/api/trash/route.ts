import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { listTrash } from '@/lib/operations/trash';

export async function GET(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
  const cursor = url.searchParams.get('cursor');

  try {
    const db = await getDb();
    const page = await listTrash(db, { ...(limit ? { limit } : {}), cursor });
    return jsonResponse(page);
  } catch (err) {
    console.error('[GET /api/trash ERROR]', err);
    return jsonError('Failed to load Trash', 500, 'TRASH_READ_FAILED');
  }
}
