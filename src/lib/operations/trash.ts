import { and, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { AppDatabase } from '../db';
import { achievements, assets } from '../db/schema';
import type { StorageAdapter } from '../storage/adapter';

export class TrashError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'TrashError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface TrashItem {
  id: string;
  title: string;
  completionDate: string;
  notes: string | null;
  tags: string[];
  trashedAt: string;
}

export interface TrashPage {
  items: TrashItem[];
  nextCursor: string | null;
}

const DEFAULT_TRASH_LIMIT = 24;
const MAX_TRASH_LIMIT = 50;

/**
 * Moves a finished artwork to Trash. Repeating the request is safe and never
 * touches the stored files, so the bytes stay counted until a purge succeeds.
 */
export async function moveToTrash(
  db: AppDatabase,
  id: string
): Promise<{ id: string; trashed: true; alreadyTrashed: boolean }> {
  const trashed = await db
    .update(achievements)
    .set({ trashedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(achievements.id, id),
        eq(achievements.state, 'ready'),
        isNull(achievements.trashedAt)
      )
    )
    .returning({ id: achievements.id });

  if (trashed[0]) {
    return { id, trashed: true, alreadyTrashed: false };
  }

  const [current] = await db.select().from(achievements).where(eq(achievements.id, id));
  if (!current) {
    throw new TrashError('NOT_FOUND', 'Achievement not found', 404);
  }
  if (current.state === 'deleting') {
    throw new TrashError(
      'ACHIEVEMENT_DELETING',
      'This artwork is being permanently deleted and cannot be moved to Trash.',
      409
    );
  }
  if (current.state !== 'ready') {
    throw new TrashError('NOT_READY', 'Only finished artwork can be moved to Trash.', 409);
  }

  return { id, trashed: true, alreadyTrashed: true };
}

/**
 * Returns a trashed artwork to the gallery. A conditional update means a restore
 * can never clear a claimed deleting state.
 */
export async function restoreFromTrash(
  db: AppDatabase,
  id: string
): Promise<{ id: string; restored: true; alreadyRestored: boolean }> {
  const restored = await db
    .update(achievements)
    .set({ trashedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(achievements.id, id),
        eq(achievements.state, 'ready'),
        isNotNull(achievements.trashedAt)
      )
    )
    .returning({ id: achievements.id });

  if (restored[0]) {
    return { id, restored: true, alreadyRestored: false };
  }

  const [current] = await db.select().from(achievements).where(eq(achievements.id, id));
  if (!current) {
    throw new TrashError('NOT_FOUND', 'Achievement not found', 404);
  }
  if (current.state === 'deleting') {
    throw new TrashError(
      'ACHIEVEMENT_DELETING',
      'This artwork is being permanently deleted and cannot be restored.',
      409
    );
  }
  if (current.state !== 'ready') {
    throw new TrashError('NOT_READY', 'Only finished artwork can be restored.', 409);
  }

  return { id, restored: true, alreadyRestored: true };
}

async function keysForAchievement(db: AppDatabase, id: string): Promise<string[]> {
  const assetRows = await db.select().from(assets).where(eq(assets.achievementId, id));
  const keys = new Set<string>();

  for (const asset of assetRows) {
    keys.add(asset.originalKey);
    keys.add(asset.displayKey);
    keys.add(asset.thumbnailKey);
    for (const retired of asset.retiredObjects) {
      for (const key of retired.keys) keys.add(key);
    }
  }

  return [...keys];
}

/**
 * The one permanent-cleanup path shared by the purge endpoint and maintenance.
 * Objects are removed first; database rows are deleted only after the provider
 * confirms. A thrown deletion leaves everything in place for a retry.
 */
export async function purgeDeletingAchievement(
  db: AppDatabase,
  storage: StorageAdapter,
  id: string
): Promise<'deleted' | 'pending'> {
  const [row] = await db
    .select({ id: achievements.id, state: achievements.state })
    .from(achievements)
    .where(eq(achievements.id, id));

  if (!row) return 'deleted';

  if (row.state !== 'deleting') {
    throw new TrashError('NOT_DELETING', 'This artwork is not marked for permanent deletion.', 409);
  }

  const keys = await keysForAchievement(db, id);
  if (keys.length > 0) {
    try {
      await storage.deleteObjects(keys);
    } catch (error) {
      console.warn('[PURGE CLEANUP PENDING]', error);
      return 'pending';
    }
  }

  // Delete database references only after the awaited deletion succeeds.
  await db.transaction(async (tx) => {
    await tx.delete(assets).where(eq(assets.achievementId, id));
    await tx.delete(achievements).where(eq(achievements.id, id));
  });

  return 'deleted';
}

/**
 * Requires a trashed artwork, claims the deleting state conditionally, and then
 * converges the object cleanup. A previous partial attempt is retried.
 */
export async function purgeAchievement(
  db: AppDatabase,
  storage: StorageAdapter,
  id: string
): Promise<{ id: string; status: 'deleted' | 'pending'; resumed: boolean }> {
  const [existing] = await db.select().from(achievements).where(eq(achievements.id, id));
  if (!existing) {
    throw new TrashError('NOT_FOUND', 'Achievement not found', 404);
  }

  if (existing.state === 'deleting') {
    const status = await purgeDeletingAchievement(db, storage, id);
    return { id, status, resumed: true };
  }

  if (!existing.trashedAt) {
    throw new TrashError(
      'NOT_TRASHED',
      'Move the artwork to Trash before deleting it permanently.',
      409
    );
  }

  const claimed = await db
    .update(achievements)
    .set({ state: 'deleting', updatedAt: new Date() })
    .where(
      and(
        eq(achievements.id, id),
        eq(achievements.state, 'ready'),
        isNotNull(achievements.trashedAt)
      )
    )
    .returning({ id: achievements.id });

  if (!claimed[0]) {
    const [current] = await db.select().from(achievements).where(eq(achievements.id, id));
    if (current?.state === 'deleting') {
      const status = await purgeDeletingAchievement(db, storage, id);
      return { id, status, resumed: true };
    }
    throw new TrashError(
      'NOT_TRASHED',
      'Move the artwork to Trash before deleting it permanently.',
      409
    );
  }

  const status = await purgeDeletingAchievement(db, storage, id);
  return { id, status, resumed: false };
}

/**
 * Trashed metadata only: no storage keys, no signed URLs, and no reuse of the
 * healthy-gallery cursor. Ordered by when each artwork entered Trash.
 */
export async function listTrash(
  db: AppDatabase,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<TrashPage> {
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_TRASH_LIMIT),
    MAX_TRASH_LIMIT
  );

  const conditions = [eq(achievements.state, 'ready'), isNotNull(achievements.trashedAt)];

  const cursor = options.cursor?.split('_') ?? null;
  if (cursor && cursor.length === 2) {
    const cursorTime = new Date(cursor[0] ?? '');
    const cursorId = cursor[1] ?? '';
    if (!Number.isNaN(cursorTime.getTime()) && cursorId) {
      conditions.push(
        or(
          lt(achievements.trashedAt, cursorTime),
          and(eq(achievements.trashedAt, cursorTime), lt(achievements.id, cursorId))
        )!
      );
    }
  }

  const rows = await db
    .select({
      id: achievements.id,
      title: achievements.title,
      completionDate: achievements.completionDate,
      notes: achievements.notes,
      tags: achievements.tags,
      trashedAt: achievements.trashedAt,
    })
    .from(achievements)
    .where(and(...conditions))
    .orderBy(desc(achievements.trashedAt), desc(achievements.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      completionDate: row.completionDate,
      notes: row.notes,
      tags: row.tags ?? [],
      trashedAt: (row.trashedAt ?? new Date()).toISOString(),
    })),
    nextCursor:
      hasMore && last?.trashedAt ? `${last.trashedAt.toISOString()}_${last.id}` : null,
  };
}
