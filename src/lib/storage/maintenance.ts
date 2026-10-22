import { eq, and, lt } from 'drizzle-orm';
import { AppDatabase } from '../db';
import { uploadIntents, achievements, assets } from '../db/schema';
import { StorageAdapter } from './adapter';

export interface CleanupResult {
  cleanedIntentsCount: number;
  cleanedAchievementsCount: number;
}

/**
 * Reclaims storage quota and removes orphaned quarantine files for expired upload intents.
 */
export async function cleanExpiredUploadIntents(
  db: AppDatabase,
  storage: StorageAdapter
): Promise<number> {
  const now = new Date();

  // Find pending intents that have passed expiration
  const expiredIntents = await db
    .select({
      id: uploadIntents.id,
      quarantineKey: uploadIntents.quarantineKey,
    })
    .from(uploadIntents)
    .where(
      and(
        eq(uploadIntents.status, 'pending'),
        lt(uploadIntents.expiresAt, now)
      )
    );

  let cleaned = 0;
  for (const intent of expiredIntents) {
    try {
      await storage.deleteObject(intent.quarantineKey);
    } catch {
      // Storage deletion failure or missing file in quarantine should not block DB state transition
    }

    await db
      .update(uploadIntents)
      .set({ status: 'cleaned' })
      .where(eq(uploadIntents.id, intent.id));

    cleaned++;
  }

  return cleaned;
}

/**
 * Idempotently cleans up assets and purges achievements stuck in 'deleting' state.
 */
export async function cleanDeletingAchievements(
  db: AppDatabase,
  storage: StorageAdapter
): Promise<number> {
  const deleting = await db
    .select({
      id: achievements.id,
    })
    .from(achievements)
    .where(eq(achievements.state, 'deleting'));

  let cleaned = 0;
  for (const ach of deleting) {
    const linkedAssets = await db
      .select({
        originalKey: assets.originalKey,
        displayKey: assets.displayKey,
        thumbnailKey: assets.thumbnailKey,
      })
      .from(assets)
      .where(eq(assets.achievementId, ach.id));

    for (const asset of linkedAssets) {
      await storage.deleteObjects([
        asset.originalKey,
        asset.displayKey,
        asset.thumbnailKey,
      ]).catch(() => {});
    }

    await db.delete(achievements).where(eq(achievements.id, ach.id));
    cleaned++;
  }

  return cleaned;
}

/**
 * Runs full maintenance routine across expired intents and tombstoned achievements.
 */
export async function runStorageMaintenance(
  db: AppDatabase,
  storage: StorageAdapter
): Promise<CleanupResult> {
  const cleanedIntentsCount = await cleanExpiredUploadIntents(db, storage);
  const cleanedAchievementsCount = await cleanDeletingAchievements(db, storage);
  return { cleanedIntentsCount, cleanedAchievementsCount };
}
