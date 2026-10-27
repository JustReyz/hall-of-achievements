import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { getStorage } from '@/lib/storage';
import { purgeAchievement, TrashError } from '@/lib/operations/trash';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const { id } = await params;
  if (!id) return jsonError('Missing achievement ID', 400, 'INVALID_INPUT');

  try {
    const db = await getDb();
    const storage = getStorage();
    const result = await purgeAchievement(db, storage, id);

    if (result.status === 'deleted') {
      return jsonResponse({ deleted: true, id: result.id });
    }

    return jsonResponse(
      {
        deleted: false,
        id: result.id,
        pendingCleanup: true,
        message:
          'The stored files could not all be removed. The artwork stays in the deletion queue and cleanup will be retried.',
      },
      { status: 202 }
    );
  } catch (err) {
    if (err instanceof TrashError) {
      return jsonError(err.message, err.statusCode, err.code);
    }
    console.error('[DELETE /api/achievements/:id/purge ERROR]', err);
    return jsonError('Failed to delete artwork permanently', 500, 'PURGE_FAILED');
  }
}
