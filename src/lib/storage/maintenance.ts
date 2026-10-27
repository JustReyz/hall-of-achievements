import { eq, and, lt, isNull, ne } from 'drizzle-orm';
import { AppDatabase } from '../db';
import { uploadIntents, achievements, assets, type RetiredObject, type UploadIntent } from '../db/schema';
import { StorageAdapter } from './adapter';

export interface CleanupResult {
  cleanedIntentsCount: number;
  cleanedAchievementsCount: number;
  cleanedRetiredGroupsCount: number;
}

/**
 * Deletes the quarantine object and records the confirmation. Returns false
 * while the provider still holds the file, which keeps the reservation counted.
 */
async function removeQuarantine(
  db: AppDatabase,
  storage: StorageAdapter,
  intent: UploadIntent
): Promise<boolean> {
  try {
    await storage.deleteObject(intent.quarantineKey);
  } catch {
    return false;
  }

  await db
    .update(uploadIntents)
    .set({ quarantineCleanedAt: new Date() })
    .where(eq(uploadIntents.id, intent.id));

  return true;
}

/**
 * Removes the partial permanent objects an expired intent left behind.
 */
async function removePartialPermanentState(
  storage: StorageAdapter,
  intent: UploadIntent
): Promise<boolean> {
  if (intent.permanentKeys.length === 0) return true;

  try {
    await storage.deleteObjects(intent.permanentKeys);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discards the still-pending artwork an abandoned intent was bound to. The
 * intent is unlinked first because the foreign key cascades: deleting the
 * artwork would otherwise erase the intent's own cleanup record.
 */
async function retireBoundAchievement(
  db: AppDatabase,
  intent: UploadIntent
): Promise<boolean> {
  if (!intent.achievementId) return true;

  const linkedAssets = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.achievementId, intent.achievementId));

  if (linkedAssets.length > 0) return true;

  const [row] = await db
    .select({ id: achievements.id, state: achievements.state })
    .from(achievements)
    .where(eq(achievements.id, intent.achievementId));

  if (!row || row.state !== 'pending') return true;

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(uploadIntents)
        .set({ achievementId: null })
        .where(eq(uploadIntents.id, intent.id));
      await tx.delete(achievements).where(eq(achievements.id, row.id));
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaims storage quota and removes orphaned quarantine files for expired
 * upload intents. An intent is only retired once both its quarantine copy and
 * any partial permanent objects are confirmed gone.
 */
export async function cleanExpiredUploadIntents(
  db: AppDatabase,
  storage: StorageAdapter
): Promise<number> {
  const now = new Date();

  const expiredIntents = await db
    .select()
    .from(uploadIntents)
    .where(and(eq(uploadIntents.status, 'pending'), lt(uploadIntents.expiresAt, now)));

  let cleaned = 0;
  for (const intent of expiredIntents) {
    const partialCleaned = await removePartialPermanentState(storage, intent);
    const quarantineCleaned = await removeQuarantine(db, storage, intent);

    if (!partialCleaned || !quarantineCleaned || !(await retireBoundAchievement(db, intent))) {
      // Stay out of the pending pool so the client is not offered a retry, but
      // keep the references and the counted bytes for the next pass.
      await db
        .update(uploadIntents)
        .set({ status: 'expired' })
        .where(eq(uploadIntents.id, intent.id));
      continue;
    }

    await db
      .update(uploadIntents)
      .set({ status: 'cleaned', permanentKeys: [] })
      .where(eq(uploadIntents.id, intent.id));

    cleaned++;
  }

  // Retry quarantine removals that a consumed or discarded intent left behind.
  const leftovers = await db
    .select()
    .from(uploadIntents)
    .where(and(ne(uploadIntents.status, 'pending'), isNull(uploadIntents.quarantineCleanedAt)));

  for (const intent of leftovers) {
    await removeQuarantine(db, storage, intent);
  }

  return cleaned;
}

/**
 * Retries removal of superseded asset versions. An entry survives until every
 * key in it is gone, and quota keeps counting it in the meantime.
 */
export async function cleanRetiredObjects(
  db: AppDatabase,
  storage: StorageAdapter
): Promise<number> {
  const rows = await db
    .select({ id: assets.id, retiredObjects: assets.retiredObjects })
    .from(assets);

  let cleaned = 0;
  for (const row of rows) {
    if (row.retiredObjects.length === 0) continue;

    const remaining: RetiredObject[] = [];
    for (const entry of row.retiredObjects) {
      try {
        await storage.deleteObjects(entry.keys);
        cleaned++;
      } catch {
        remaining.push(entry);
      }
    }

    if (remaining.length !== row.retiredObjects.length) {
      await db.update(assets).set({ retiredObjects: remaining }).where(eq(assets.id, row.id));
    }
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
    .select({ id: achievements.id })
    .from(achievements)
    .where(eq(achievements.state, 'deleting'));

  let cleaned = 0;
  for (const ach of deleting) {
    const linkedAssets = await db
      .select({
        id: assets.id,
        originalKey: assets.originalKey,
        displayKey: assets.displayKey,
        thumbnailKey: assets.thumbnailKey,
        retiredObjects: assets.retiredObjects,
      })
      .from(assets)
      .where(eq(assets.achievementId, ach.id));

    let cleanupPending = false;

    for (const asset of linkedAssets) {
      await storage
        .deleteObjects([asset.originalKey, asset.displayKey, asset.thumbnailKey])
        .catch(() => {});

      const remaining: RetiredObject[] = [];
      for (const retired of asset.retiredObjects) {
        try {
          await storage.deleteObjects(retired.keys);
        } catch {
          remaining.push(retired);
        }
      }

      if (remaining.length > 0) {
        await db.update(assets).set({ retiredObjects: remaining }).where(eq(assets.id, asset.id));
        cleanupPending = true;
      }
    }

    if (cleanupPending) continue;

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
  const cleanedRetiredGroupsCount = await cleanRetiredObjects(db, storage);
  return { cleanedIntentsCount, cleanedAchievementsCount, cleanedRetiredGroupsCount };
}
