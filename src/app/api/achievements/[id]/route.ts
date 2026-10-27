import { type NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { achievements, assets } from '@/lib/db/schema';
import { normalVisibilityConditions } from '@/lib/gallery/query';
import { moveToTrash, TrashError } from '@/lib/operations/trash';
import {
  validateTitle,
  validateCompletionDate,
  validateNotes,
  validateTags,
  validateThumbnailPosition,
  ValidationError,
} from '@/lib/validation/achievement';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const { id } = await params;
  if (!id) return jsonError('Missing achievement ID', 400, 'INVALID_INPUT');

  try {
    const db = await getDb();
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
      .where(and(eq(achievements.id, id), ...normalVisibilityConditions()));

    const item = rows[0];
    if (!item) {
      return jsonError('Achievement not found', 404, 'NOT_FOUND');
    }

    return jsonResponse(item);
  } catch (err) {
    console.error('[GET /api/achievements/:id ERROR]', err);
    return jsonError('Failed to fetch achievement', 500, 'DATABASE_ERROR');
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const { id } = await params;
  if (!id) return jsonError('Missing achievement ID', 400, 'INVALID_INPUT');

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON request body', 400, 'INVALID_INPUT');
  }

  const db = await getDb();

  // 1. Verify existence
  const existingRows = await db
    .select()
    .from(achievements)
    .where(and(eq(achievements.id, id), ...normalVisibilityConditions()));

  const existing = existingRows[0];
  if (!existing) {
    return jsonError('Achievement not found', 404, 'NOT_FOUND');
  }

  // 2. Validate update fields
  const clientTz = typeof body.timezone === 'string' ? body.timezone : 'UTC';
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  try {
    if (body.title !== undefined) {
      updates.title = validateTitle(body.title);
    }
    if (body.completionDate !== undefined) {
      updates.completionDate = validateCompletionDate(body.completionDate, clientTz);
    }
    if (body.notes !== undefined) {
      updates.notes = validateNotes(body.notes);
    }
    if (body.tags !== undefined) {
      updates.tags = validateTags(body.tags);
    }
    if (body.thumbnailPositionX !== undefined) {
      updates.thumbnailPositionX = validateThumbnailPosition(body.thumbnailPositionX, 'x');
    }
    if (body.thumbnailPositionY !== undefined) {
      updates.thumbnailPositionY = validateThumbnailPosition(body.thumbnailPositionY, 'y');
    }
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return jsonError(err.message, err.statusCode, err.code);
    }
    throw err;
  }

  const [updated] = await db
    .update(achievements)
    .set(updates)
    .where(eq(achievements.id, id))
    .returning();

  const assetRows = await db
    .select()
    .from(assets)
    .where(eq(assets.achievementId, id));

  const asset = assetRows[0];

  return jsonResponse({
    ...updated,
    asset: asset
      ? {
          id: asset.id,
          width: asset.width,
          height: asset.height,
          originalBytes: asset.originalBytes,
          mimeType: asset.mimeType,
          checksum: asset.checksum,
        }
      : null,
  });
}

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
    // Normal deletion is recoverable: it hides the artwork and keeps every byte
    // and record until an explicit permanent-delete action.
    const result = await moveToTrash(db, id);
    return jsonResponse({ trashed: true, id: result.id, alreadyTrashed: result.alreadyTrashed });
  } catch (err) {
    if (err instanceof TrashError) {
      return jsonError(err.message, err.statusCode, err.code);
    }
    console.error('[DELETE /api/achievements/:id ERROR]', err);
    return jsonError('Failed to move artwork to Trash', 500, 'TRASH_FAILED');
  }
}
