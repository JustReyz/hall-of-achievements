import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db';
import { achievements, assets, collectionItems, collections } from '../db/schema';
import { buildGalleryConditions } from '../gallery/query';
import type { GalleryFilters } from '@/components/gallery/types';
import { MAX_COLLECTION_MEMBERS } from '../validation/collection';

export class CollectionError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'CollectionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface CollectionSummary {
  id: string;
  name: string;
  revision: number;
  memberCount: number;
  updatedAt: string;
}

export interface CollectionMember {
  achievementId: string;
  position: number;
  title: string;
  completionDate: string;
  state: string;
  trashedAt: string | null;
}

export interface CollectionDetail {
  id: string;
  name: string;
  revision: number;
  items: CollectionMember[];
}

/**
 * Every collection with its membership count, newest first.
 */
export async function listCollections(db: AppDatabase): Promise<CollectionSummary[]> {
  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      revision: collections.revision,
      updatedAt: collections.updatedAt,
      memberCount: sql<number>`COUNT(${collectionItems.achievementId})::int`,
    })
    .from(collections)
    .leftJoin(collectionItems, eq(collectionItems.collectionId, collections.id))
    .groupBy(collections.id)
    .orderBy(desc(collections.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    revision: row.revision,
    memberCount: Number(row.memberCount ?? 0),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function createCollection(db: AppDatabase, name: string): Promise<CollectionSummary> {
  const [row] = await db.insert(collections).values({ name }).returning();
  if (!row) throw new Error('Failed to create collection');
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    memberCount: 0,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireCollection(
  db: AppDatabase,
  id: string
): Promise<{ id: string; name: string; revision: number }> {
  const [row] = await db
    .select({ id: collections.id, name: collections.name, revision: collections.revision })
    .from(collections)
    .where(eq(collections.id, id));

  if (!row) {
    throw new CollectionError('NOT_FOUND', 'Collection not found', 404);
  }
  return row;
}

/**
 * The editor view: complete membership in curated order, including members that
 * are currently in Trash so an order write can preserve them.
 */
export async function getCollectionDetail(
  db: AppDatabase,
  id: string
): Promise<CollectionDetail> {
  const collection = await requireCollection(db, id);

  const rows = await db
    .select({
      achievementId: collectionItems.achievementId,
      position: collectionItems.position,
      title: achievements.title,
      completionDate: achievements.completionDate,
      state: achievements.state,
      trashedAt: achievements.trashedAt,
    })
    .from(collectionItems)
    .innerJoin(achievements, eq(achievements.id, collectionItems.achievementId))
    .where(eq(collectionItems.collectionId, id))
    .orderBy(asc(collectionItems.position), asc(collectionItems.achievementId));

  return {
    id: collection.id,
    name: collection.name,
    revision: collection.revision,
    items: rows.map((row) => ({
      achievementId: row.achievementId,
      position: row.position,
      title: row.title,
      completionDate: row.completionDate,
      state: row.state,
      trashedAt: row.trashedAt ? row.trashedAt.toISOString() : null,
    })),
  };
}

export async function renameCollection(
  db: AppDatabase,
  id: string,
  name: string
): Promise<CollectionSummary> {
  const [row] = await db
    .update(collections)
    .set({ name, updatedAt: new Date() })
    .where(eq(collections.id, id))
    .returning();

  if (!row) {
    throw new CollectionError('NOT_FOUND', 'Collection not found', 404);
  }

  const counts = await db
    .select({ memberCount: sql<number>`COUNT(*)::int` })
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, id));

  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    memberCount: Number(counts[0]?.memberCount ?? 0),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Removes the collection and its membership rows only. Artwork is untouched.
 */
export async function deleteCollection(db: AppDatabase, id: string): Promise<void> {
  const [row] = await db.delete(collections).where(eq(collections.id, id)).returning({
    id: collections.id,
  });
  if (!row) {
    throw new CollectionError('NOT_FOUND', 'Collection not found', 404);
  }
}

/**
 * Replaces the complete ordered membership atomically. A stale revision returns
 * a conflict with no partial changes. Existing members may be in Trash; adding a
 * newly trashed or unfinished artwork is rejected.
 */
export async function replaceCollectionItems(
  db: AppDatabase,
  id: string,
  revision: number,
  achievementIds: string[]
): Promise<{ revision: number }> {
  if (achievementIds.length > MAX_COLLECTION_MEMBERS) {
    throw new CollectionError(
      'COLLECTION_LIMIT',
      `A collection holds at most ${MAX_COLLECTION_MEMBERS} artworks.`,
      400
    );
  }

  return db.transaction(async (tx) => {
    const [collection] = await tx
      .select({ id: collections.id, revision: collections.revision })
      .from(collections)
      .where(eq(collections.id, id))
      .for('update');

    if (!collection) {
      throw new CollectionError('NOT_FOUND', 'Collection not found', 404);
    }
    if (collection.revision !== revision) {
      throw new CollectionError(
        'REVISION_CONFLICT',
        'This collection changed since it was loaded. Reload it and try again.',
        409
      );
    }

    const existingRows = await tx
      .select({ achievementId: collectionItems.achievementId })
      .from(collectionItems)
      .where(eq(collectionItems.collectionId, id))
      .orderBy(asc(collectionItems.achievementId))
      .for('update');
    const existing = new Set(existingRows.map((row) => row.achievementId));

    if (achievementIds.length > 0) {
      const uniqueIds = [...new Set(achievementIds)].sort();
      const targetRows = await tx
        .select({ id: achievements.id, state: achievements.state, trashedAt: achievements.trashedAt })
        .from(achievements)
        .where(inArray(achievements.id, uniqueIds))
        .orderBy(asc(achievements.id))
        .for('update');

      const byId = new Map(targetRows.map((row) => [row.id, row]));
      for (const achievementId of achievementIds) {
        const target = byId.get(achievementId);
        if (!target) {
          throw new CollectionError(
            'UNKNOWN_ARTWORK',
            'One of the selected artworks no longer exists.',
            400
          );
        }
        if (!existing.has(achievementId) && (target.state !== 'ready' || target.trashedAt)) {
          throw new CollectionError(
            'INVALID_MEMBER',
            'Only finished artwork that is not in Trash can be added to a collection.',
            409
          );
        }
      }
    }

    await tx.delete(collectionItems).where(eq(collectionItems.collectionId, id));
    if (achievementIds.length > 0) {
      await tx.insert(collectionItems).values(
        achievementIds.map((achievementId, index) => ({
          collectionId: id,
          achievementId,
          position: index,
        }))
      );
    }

    const [updated] = await tx
      .update(collections)
      .set({ revision: collection.revision + 1, updatedAt: new Date() })
      .where(eq(collections.id, id))
      .returning({ revision: collections.revision });

    return { revision: updated?.revision ?? collection.revision + 1 };
  });
}

export interface CuratedCursor {
  collectionId: string;
  revision: number;
  position: number;
  achievementId: string;
}

export function encodeCuratedCursor(cursor: CuratedCursor): string {
  return [cursor.collectionId, cursor.revision, cursor.position, cursor.achievementId].join('_');
}

/**
 * A curated cursor belongs to exactly one collection revision. A cursor from
 * another collection, or from before a membership change, is rejected instead
 * of being silently interpreted as a date cursor.
 */
export function decodeCuratedCursor(
  raw: string,
  collectionId: string,
  revision: number
): CuratedCursor {
  const parts = raw.split('_');
  if (parts.length !== 4) {
    throw new CollectionError('CURSOR_INVALID', 'This collection cursor is malformed.', 400);
  }

  const [cursorCollection, rawRevision, rawPosition, achievementId] = parts;
  const position = Number.parseInt(rawPosition ?? '', 10);
  const cursorRevision = Number.parseInt(rawRevision ?? '', 10);

  if (
    cursorCollection !== collectionId ||
    !Number.isInteger(cursorRevision) ||
    !Number.isInteger(position) ||
    position < 0 ||
    !achievementId
  ) {
    throw new CollectionError('CURSOR_INVALID', 'This collection cursor is malformed.', 400);
  }

  if (cursorRevision !== revision) {
    throw new CollectionError(
      'CURSOR_STALE',
      'This collection changed. Reload it to see the current order.',
      409
    );
  }

  return {
    collectionId,
    revision: cursorRevision,
    position,
    achievementId,
  };
}

export interface CuratedPage {
  items: Array<{
    id: string;
    title: string;
    completionDate: string;
    notes: string | null;
    tags: string[];
    thumbnailPositionX: number;
    thumbnailPositionY: number;
    state: string;
    createdAt: Date;
    updatedAt: Date;
    position: number;
    asset: {
      id: string;
      width: number;
      height: number;
      originalBytes: number;
      mimeType: string;
      checksum: string;
    } | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
  revision: number;
  name: string;
}

/**
 * One page of a curated view. Search, exact tag, and date filters narrow the
 * members; the curated order is preserved and never replaced by date order.
 */
export async function listCollectionItems(
  db: AppDatabase,
  id: string,
  options: {
    cursor?: string | null;
    limit?: number;
    filters: GalleryFilters;
  }
): Promise<CuratedPage> {
  const collection = await requireCollection(db, id);
  const limit = Math.min(Math.max(1, options.limit ?? 24), 50);
  const cursor = options.cursor
    ? decodeCuratedCursor(options.cursor, collection.id, collection.revision)
    : null;

  const conditions = buildGalleryConditions(options.filters);
  conditions.push(eq(collectionItems.collectionId, id));

  if (cursor) {
    conditions.push(
      or(
        gt(collectionItems.position, cursor.position),
        and(
          eq(collectionItems.position, cursor.position),
          gt(collectionItems.achievementId, cursor.achievementId)
        )
      )!
    );
  }

  const rows = await db
    .select({
      id: achievements.id,
      title: achievements.title,
      completionDate: achievements.completionDate,
      notes: achievements.notes,
      tags: achievements.tags,
      thumbnailPositionX: achievements.thumbnailPositionX,
      thumbnailPositionY: achievements.thumbnailPositionY,
      state: achievements.state,
      createdAt: achievements.createdAt,
      updatedAt: achievements.updatedAt,
      position: collectionItems.position,
      asset: {
        id: assets.id,
        width: assets.width,
        height: assets.height,
        originalBytes: assets.originalBytes,
        mimeType: assets.mimeType,
        checksum: assets.checksum,
      },
    })
    .from(collectionItems)
    .innerJoin(achievements, eq(achievements.id, collectionItems.achievementId))
    .leftJoin(assets, eq(assets.achievementId, achievements.id))
    .where(and(...conditions))
    .orderBy(asc(collectionItems.position), asc(collectionItems.achievementId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page,
    hasMore,
    revision: collection.revision,
    name: collection.name,
    nextCursor:
      hasMore && last
        ? encodeCuratedCursor({
            collectionId: collection.id,
            revision: collection.revision,
            position: last.position,
            achievementId: last.id,
          })
        : null,
  };
}

/**
 * Invalidates curated cursors after a membership visibility change. Collections
 * are locked in UUID order so concurrent bumps cannot deadlock.
 */
export async function bumpCollectionsForAchievement(
  db: AppDatabase,
  achievementId: string
): Promise<void> {
  const memberships = await db
    .select({ collectionId: collectionItems.collectionId })
    .from(collectionItems)
    .where(eq(collectionItems.achievementId, achievementId))
    .orderBy(asc(collectionItems.collectionId));

  if (memberships.length === 0) return;

  const ids = [...new Set(memberships.map((row) => row.collectionId))];

  await db.transaction(async (tx) => {
    await tx
      .select({ id: collections.id })
      .from(collections)
      .where(inArray(collections.id, ids))
      .orderBy(asc(collections.id))
      .for('update');

    await tx
      .update(collections)
      .set({ revision: sql`${collections.revision} + 1`, updatedAt: new Date() })
      .where(inArray(collections.id, ids));
  });
}
