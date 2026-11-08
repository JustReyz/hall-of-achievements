import { type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { uploadIntents, achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const { id } = await params;
  if (!id) return jsonError('Missing intent ID', 400, 'INVALID_INPUT');

  const db = await getDb();
  const storage = getStorage();

  const [intent] = await db
    .select()
    .from(uploadIntents)
    .where(eq(uploadIntents.id, id));

  if (!intent) {
    return jsonError('Upload intent not found', 404, 'NOT_FOUND');
  }

  if (intent.status === 'consumed') {
    return jsonError(
      'Cannot cancel an already consumed upload intent',
      409,
      'INTENT_ALREADY_CONSUMED'
    );
  }

  // Best-effort delete of the quarantine object from storage
  try {
    await storage.deleteObject(intent.quarantineKey);
  } catch {
    // Non-blocking storage delete: if object was never uploaded or already gone
  }

  // If intent was linked to a pending achievement with no committed assets, clean up the pending achievement
  if (intent.achievementId) {
    try {
      const linkedAssets = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.achievementId, intent.achievementId));

      if (linkedAssets.length === 0) {
        const [ach] = await db
          .select({ id: achievements.id, state: achievements.state })
          .from(achievements)
          .where(eq(achievements.id, intent.achievementId));

        if (ach && ach.state === 'pending') {
          await db
            .update(uploadIntents)
            .set({ achievementId: null })
            .where(eq(uploadIntents.id, intent.id));
          await db.delete(achievements).where(eq(achievements.id, ach.id));
        }
      }
    } catch (cleanupErr) {
      console.warn('[INTENT CANCELLATION] Failed to clean bound pending achievement:', cleanupErr);
    }
  }

  // Mark intent status = 'cleaned' and record quarantineCleanedAt to immediately release slot and quota
  await db
    .update(uploadIntents)
    .set({
      status: 'cleaned',
      quarantineCleanedAt: new Date(),
    })
    .where(eq(uploadIntents.id, intent.id));

  return jsonResponse({
    success: true,
    message: 'Upload intent cancelled and quota freed',
  });
}
