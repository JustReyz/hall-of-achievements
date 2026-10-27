import { type NextRequest } from 'next/server';
import { eq, and, or, lt, desc } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { achievements, assets, uploadIntents } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { validateImageBuffer, ImageValidationError } from '@/lib/image/validator';
import { processImageDerivatives } from '@/lib/image/processor';
import { buildGalleryConditions } from '@/lib/gallery/query';
import type { GalleryFilters } from '@/components/gallery/types';
import {
  validateTitle,
  validateCompletionDate,
  validateNotes,
  validateTags,
  validateTagFilter,
  validateDateRange,
  ValidationError,
} from '@/lib/validation/achievement';

const DEFAULT_PAGE_LIMIT = 24;

export async function GET(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const url = new URL(request.url);
  let range: { from: string; to: string };
  let tag: string;
  try {
    range = validateDateRange(url.searchParams.get('from'), url.searchParams.get('to'));
    tag = validateTagFilter(url.searchParams.get('tag'));
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(err.message, err.statusCode, err.code);
    throw err;
  }
  const q = url.searchParams.get('q')?.trim() || '';
  const filters: GalleryFilters = { q, from: range.from, to: range.to, tag };
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
      conditions.push(
        or(
          lt(achievements.completionDate, cursorDate),
          and(
            eq(achievements.completionDate, cursorDate),
            lt(achievements.id, cursorId)
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
      .orderBy(desc(achievements.completionDate), desc(achievements.id))
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
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON request body', 400, 'INVALID_INPUT');
  }

  // Validate fields
  let title: string;
  let completionDate: string;
  let notes: string;
  let tags: string[];
  const clientTz = typeof body.timezone === 'string' ? body.timezone : 'UTC';

  try {
    title = validateTitle(body.title);
    completionDate = validateCompletionDate(body.completionDate, clientTz);
    notes = validateNotes(body.notes);
    tags = validateTags(body.tags);
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return jsonError(err.message, err.statusCode, err.code);
    }
    throw err;
  }

  const intentId = typeof body.intentId === 'string' ? body.intentId.trim() : null;
  if (!intentId) {
    return jsonError('intentId is required to create an achievement with artwork', 400, 'MISSING_INTENT_ID');
  }

  const db = await getDb();
  const storage = getStorage();

  // 1. Verify upload intent
  const intentRows = await db
    .select()
    .from(uploadIntents)
    .where(eq(uploadIntents.id, intentId));

  const intent = intentRows[0];
  if (!intent) {
    return jsonError('Upload intent not found', 404, 'NOT_FOUND');
  }

  if (intent.status === 'consumed') {
    return jsonError('Upload intent has already been consumed', 400, 'ALREADY_CONSUMED');
  }

  const now = new Date();
  if (intent.status === 'expired' || now.getTime() > new Date(intent.expiresAt).getTime()) {
    return jsonError('Upload intent has expired and cannot be promoted', 410, 'INTENT_EXPIRED');
  }

  // 2. Fetch quarantine bytes from storage
  let quarantineData: Buffer;
  try {
    const quarantineObj = await storage.getObject(intent.quarantineKey);
    quarantineData = quarantineObj.data;
  } catch {
    return jsonError('Quarantined file not found in storage. Upload may not have completed.', 400, 'UPLOAD_NOT_FOUND');
  }

  // 3. Two-stage image validation
  let validated;
  try {
    validated = await validateImageBuffer(quarantineData);
  } catch (err: unknown) {
    await storage.deleteObject(intent.quarantineKey).catch(() => {});
    await db
      .update(uploadIntents)
      .set({ status: 'cleaned' })
      .where(eq(uploadIntents.id, intent.id));

    if (err instanceof ImageValidationError) {
      return jsonError(err.message, err.statusCode, err.code);
    }
    return jsonError('Image validation failed', 400, 'CORRUPT_IMAGE');
  }

  // 4. Generate derivatives
  let derivatives;
  try {
    derivatives = await processImageDerivatives(quarantineData);
  } catch (err) {
    console.error('[PROCESS DERIVATIVES ERROR]', err);
    return jsonError('Failed to process image derivatives', 500, 'DERIVATIVE_PROCESSING_FAILED');
  }

  const achievementId = crypto.randomUUID();
  const ext = validated.mimeType === 'image/jpeg' ? 'jpg' : validated.mimeType === 'image/png' ? 'png' : 'webp';
  const originalKey = `originals/${achievementId}/original.${ext}`;
  const displayKey = `derivatives/${achievementId}/display.webp`;
  const thumbnailKey = `derivatives/${achievementId}/thumb.webp`;

  // 5. Store permanent assets
  try {
    await storage.putObject(originalKey, quarantineData, {
      contentType: validated.mimeType,
      cacheControl: 'private, no-store',
    });
    await storage.putObject(displayKey, derivatives.displayBuffer, {
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
    });
    await storage.putObject(thumbnailKey, derivatives.thumbnailBuffer, {
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
    });

    // Clean up quarantine object
    await storage.deleteObject(intent.quarantineKey).catch(() => {});
  } catch (err) {
    console.error('[STORAGE WRITE ERROR]', err);
    return jsonError('Failed to store processed images', 500, 'STORAGE_WRITE_FAILED');
  }

  // 6. Persist records in DB
  const assetId = crypto.randomUUID();

  const [newAchievement] = await db
    .insert(achievements)
    .values({
      id: achievementId,
      title,
      completionDate,
      notes,
      tags,
      state: 'ready',
    })
    .returning();

  const [newAsset] = await db
    .insert(assets)
    .values({
      id: assetId,
      achievementId,
      originalKey,
      displayKey,
      thumbnailKey,
      originalBytes: validated.byteLength,
      mimeType: validated.mimeType,
      width: validated.width,
      height: validated.height,
      checksum: validated.checksum,
    })
    .returning();

  await db
    .update(uploadIntents)
    .set({ status: 'consumed', achievementId })
    .where(eq(uploadIntents.id, intent.id));

  if (!newAchievement || !newAsset) {
    throw new Error('Failed to create achievement or asset record');
  }

  return jsonResponse(
    {
      ...newAchievement,
      asset: {
        id: newAsset.id,
        width: newAsset.width,
        height: newAsset.height,
        originalBytes: newAsset.originalBytes,
        mimeType: newAsset.mimeType,
        checksum: newAsset.checksum,
      },
    },
    { status: 201 }
  );
}
