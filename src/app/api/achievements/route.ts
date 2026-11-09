import { type NextRequest } from 'next/server';
import { eq, and, or, lt, gt, desc, asc } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { achievements, assets } from '@/lib/db/schema';
import { buildGalleryConditions } from '@/lib/gallery/query';
import type { GalleryFilters } from '@/components/gallery/types';
import { finalizeUpload } from '@/lib/uploads/finalize';
import {
  validateTagFilter,
  validateDateRange,
  validateAchievementSort,
  type AchievementSort,
  ValidationError,
} from '@/lib/validation/achievement';

const DEFAULT_PAGE_LIMIT = 24;

export async function GET(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const url = new URL(request.url);
  let range: { from: string; to: string };
  let tag: string;
  let sort: AchievementSort;
  try {
    range = validateDateRange(url.searchParams.get('from'), url.searchParams.get('to'));
    tag = validateTagFilter(url.searchParams.get('tag'));
    sort = validateAchievementSort(url.searchParams.get('sort'));
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(err.message, err.statusCode, err.code);
    throw err;
  }
  const q = url.searchParams.get('q')?.trim() || '';
  const filters: GalleryFilters = { q, from: range.from, to: range.to, tag, sort };
  const cursorParam = url.searchParams.get('cursor')?.trim();
  const limitParam = parseInt(url.searchParams.get('limit') || String(DEFAULT_PAGE_LIMIT), 10);
  const limit = isNaN(limitParam) || limitParam < 1 ? DEFAULT_PAGE_LIMIT : Math.min(limitParam, 50);

  // Parse cursor: format is "<YYYY-MM-DD>_<UUID>"
  let cursorDate: string | null = null;
  let cursorId: string | null = null;

  if (cursorParam) {
    const separatorIdx = cursorParam.indexOf('_');
    if (separatorIdx > 0) {
      cursorDate = cursorParam.substring(0, separatorIdx);
      cursorId = cursorParam.substring(separatorIdx + 1);
    }
  }

  try {
    const db = await getDb();

    // Build conditions
    const conditions = buildGalleryConditions(filters);

    // Cursor pagination condition
    if (cursorDate && cursorId) {
      if (sort === 'oldest') {
        conditions.push(
          or(
            gt(achievements.completionDate, cursorDate),
            and(eq(achievements.completionDate, cursorDate), gt(achievements.id, cursorId))
          )!
        );
      } else {
        conditions.push(
          or(
            lt(achievements.completionDate, cursorDate),
            and(eq(achievements.completionDate, cursorDate), lt(achievements.id, cursorId))
          )!
        );
      }
    }

    const orderClause =
      sort === 'oldest'
        ? [asc(achievements.completionDate), asc(achievements.id)]
        : [desc(achievements.completionDate), desc(achievements.id)];

    const rows = await db
      .select({
        id: achievements.id,
        title: achievements.title,
        completionDate: achievements.completionDate,
        notes: achievements.notes,
        imageDescription: achievements.imageDescription,
        tags: achievements.tags,
        thumbnailPositionX: achievements.thumbnailPositionX,
        thumbnailPositionY: achievements.thumbnailPositionY,
        state: achievements.state,
        createdAt: achievements.createdAt,
        updatedAt: achievements.updatedAt,
        asset: {
          id: assets.id,
          width: assets.width,
          height: assets.height,
          originalBytes: assets.originalBytes,
          mimeType: assets.mimeType,
          checksum: assets.checksum,
        },
      })
      .from(achievements)
      .leftJoin(assets, eq(assets.achievementId, achievements.id))
      .where(and(...conditions))
      .orderBy(...orderClause)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      if (last) {
        nextCursor = `${last.completionDate}_${last.id}`;
      }
    }

    return jsonResponse({
      items,
      nextCursor,
      hasMore,
    });
  } catch (err) {
    console.error('[GET /api/achievements ERROR]', err);
    return jsonError('Failed to fetch achievements', 500, 'DATABASE_ERROR');
  }
}

export async function POST(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return jsonError('Request body must be a JSON object', 400, 'INVALID_INPUT');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON request body', 400, 'INVALID_INPUT');
  }

  const intentId = typeof body.intentId === 'string' ? body.intentId.trim() : null;
  if (!intentId) {
    return jsonError(
      'intentId is required to create an achievement with artwork',
      400,
      'MISSING_INTENT_ID'
    );
  }

  // One finalize implementation owns intent binding, idempotent replay, object
  // cleanup, and storage accounting; this route only shapes the create response.
  const result = await finalizeUpload(intentId, body);
  if (!result.ok) {
    return jsonError(result.message, result.status, result.code);
  }

  return jsonResponse(
    { ...result.payload.achievement, asset: result.payload.asset },
    { status: 201 }
  );
}
