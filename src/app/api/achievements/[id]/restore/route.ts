import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { restoreFromTrash, TrashError } from '@/lib/operations/trash';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const { id } = await params;
  if (!id) return jsonError('Missing achievement ID', 400, 'INVALID_INPUT');

  try {
    const db = await getDb();
    const result = await restoreFromTrash(db, id);
    return jsonResponse({ restored: true, id: result.id, alreadyRestored: result.alreadyRestored });
  } catch (err) {
    if (err instanceof TrashError) {
      return jsonError(err.message, err.statusCode, err.code);
    }
    console.error('[POST /api/achievements/:id/restore ERROR]', err);
    return jsonError('Failed to restore artwork', 500, 'RESTORE_FAILED');
  }
}
