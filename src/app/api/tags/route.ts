import { type NextRequest } from 'next/server';
import { and, sql } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { achievements } from '@/lib/db/schema';
import { buildGalleryConditions } from '@/lib/gallery/query';
import { validateDateRange, ValidationError } from '@/lib/validation/achievement';
import { validateCollectionId } from '@/lib/validation/collection';
import type { GalleryFilters } from '@/components/gallery/types';

export async function GET(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const url = new URL(request.url);
  let range: { from: string; to: string };
  let collectionId: string | null = null;
  try {
    range = validateDateRange(url.searchParams.get('from'), url.searchParams.get('to'));
    const rawCollection = url.searchParams.get('collectionId');
    collectionId = rawCollection ? validateCollectionId(rawCollection) : null;
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(err.message, err.statusCode, err.code);
    throw err;
  }

  const filters: GalleryFilters = {
    q: url.searchParams.get('q')?.trim() || '',
    from: range.from,
    to: range.to,
    // The facet deliberately ignores any selected tag so alternatives stay discoverable.
    tag: '',
  };

  try {
    const db = await getDb();
    const conditions = buildGalleryConditions(filters);
    if (collectionId) {
      // The facet follows the curated scope without changing the curated order.
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM collection_items ci
          WHERE ci.collection_id = ${collectionId}
            AND ci.achievement_id = ${achievements.id}
        )`
      );
    }

    const rows = await db
      .select({ tags: achievements.tags })
      .from(achievements)
      .where(and(...conditions));

    const tags = Array.from(
      new Set(
        rows.flatMap((row) => row.tags ?? []).filter((tag) => tag.length > 0)
      )
    ).sort();

    return jsonResponse({ tags });
  } catch (err) {
    console.error('[GET /api/tags ERROR]', err);
    return jsonError('Failed to fetch tags', 500, 'DATABASE_ERROR');
  }
}
