import { type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { uploadIntents, achievements, assets, Achievement } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { validateImageBuffer, ImageValidationError } from '@/lib/image/validator';
import { processImageDerivatives } from '@/lib/image/processor';
import {
  validateTitle,
  validateCompletionDate,
  validateNotes,
  validateTags,
  ValidationError,
} from '@/lib/validation/achievement';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const { id: intentId } = await params;
  if (!intentId) {
    return jsonError('Missing intent ID', 400, 'INVALID_INPUT');
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Body is optional on finalize retry
  }

  const db = await getDb();
  const storage = getStorage();

  // 1. Look up UploadIntent
  const intentRows = await db
    .select()
    .from(uploadIntents)
    .where(eq(uploadIntents.id, intentId));

  const intent = intentRows[0];
  if (!intent) {
    return jsonError('Upload intent not found', 404, 'NOT_FOUND');
  }

  // 2. Check for idempotent replay
  if (intent.status === 'consumed') {
    const targetAchId = intent.achievementId || (typeof body.achievementId === 'string' ? body.achievementId : null);
    if (targetAchId) {
      const achRows = await db
        .select()
        .from(achievements)
        .where(eq(achievements.id, targetAchId));
      const assetRows = await db
        .select()
        .from(assets)
        .where(eq(assets.achievementId, targetAchId));

      if (achRows[0] && assetRows[0]) {
        return jsonResponse({
          finalized: true,
          achievement: achRows[0],
          asset: {
            id: assetRows[0].id,
            width: assetRows[0].width,
            height: assetRows[0].height,
            originalBytes: assetRows[0].originalBytes,
            mimeType: assetRows[0].mimeType,
            checksum: assetRows[0].checksum,
          },
        });
      }
    }
  }

  // 3. Expiration check
  const now = new Date();
  if (intent.status === 'expired' || now.getTime() > new Date(intent.expiresAt).getTime()) {
    if (intent.status !== 'expired' && intent.status !== 'cleaned') {
      await db
        .update(uploadIntents)
        .set({ status: 'expired' })
        .where(eq(uploadIntents.id, intent.id));
    }
    return jsonError('Upload intent has expired and cannot be promoted', 410, 'INTENT_EXPIRED');
  }

  // 4. Fetch quarantine bytes from storage
  let quarantineData: Buffer;
  try {
    const quarantineObj = await storage.getObject(intent.quarantineKey);
    quarantineData = quarantineObj.data;
  } catch {
    return jsonError('Quarantined file not found in storage. Upload may not have completed.', 400, 'UPLOAD_NOT_FOUND');
  }

  // 5. Two-stage validation
  let validated;
  try {
    validated = await validateImageBuffer(quarantineData);
  } catch (err: unknown) {
    // Delete invalid quarantine object and mark intent cleaned
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

  // 6. Process derivatives (auto-rotate, EXIF stripped, display WebP & thumb WebP)
  let derivatives;
  try {
    derivatives = await processImageDerivatives(quarantineData);
  } catch (err: unknown) {
    console.error('[DERIVATIVE ERROR]', err);
    return jsonError('Failed to generate image derivatives', 500, 'DERIVATIVE_PROCESSING_FAILED');
  }

  // 7. Determine / validate Achievement record
  let achievementId: string;
  let achievementRecord: Achievement;

  try {
    if (typeof body.achievementId === 'string' && body.achievementId) {
      achievementId = body.achievementId;
      const achRows = await db
        .select()
        .from(achievements)
        .where(eq(achievements.id, achievementId));
      if (!achRows[0]) {
        return jsonError('Linked achievement not found', 404, 'NOT_FOUND');
      }
      if (achRows[0].state === 'deleting') {
        return jsonError(
          'Achievement is being deleted and cannot receive new artwork',
          409,
          'ACHIEVEMENT_DELETING'
        );
      }
      achievementRecord = achRows[0];
    } else {
      // Create new achievement record
      achievementId = crypto.randomUUID();
      const defaultTitle = intent.fileName.replace(/\.[^/.]+$/, '') || 'Untitled Artwork';
      const title = validateTitle(body.title ?? defaultTitle);

      const clientTz = typeof body.timezone === 'string' ? body.timezone : 'UTC';
      const todayDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: clientTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);

      const completionDate = validateCompletionDate(body.completionDate ?? todayDate, clientTz);
      const notes = validateNotes(body.notes);
      const tags = validateTags(body.tags);

      const [newAch] = await db
        .insert(achievements)
        .values({
          id: achievementId,
          title,
          completionDate,
          notes,
          tags,
          state: 'pending',
        })
        .returning();

      if (!newAch) {
        throw new Error('Failed to create achievement record');
      }
      achievementRecord = newAch;
    }
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return jsonError(err.message, err.statusCode, err.code);
    }
    throw err;
  }

  // 8. Detect whether this upload re-attaches artwork to an existing achievement.
  // The asset keys are derived from the achievement ID, so a replacement must
  // overwrite the existing objects instead of failing the no-overwrite guard.
  const existingAssets = await db
    .select()
    .from(assets)
    .where(eq(assets.achievementId, achievementId));
  const isReplacement = existingAssets.length > 0;
  const staleKeys = existingAssets
    .flatMap((existing) => [existing.originalKey, existing.displayKey, existing.thumbnailKey]);

  // 9. Put permanent objects into storage
  const ext = validated.mimeType === 'image/jpeg' ? 'jpg' : validated.mimeType === 'image/png' ? 'png' : 'webp';
  const originalKey = `originals/${achievementId}/original.${ext}`;
  const displayKey = `derivatives/${achievementId}/display.webp`;
  const thumbnailKey = `derivatives/${achievementId}/thumb.webp`;

  try {
    await storage.putObject(originalKey, quarantineData, {
      contentType: validated.mimeType,
      cacheControl: 'private, no-store',
      upsert: isReplacement,
    });

    await storage.putObject(displayKey, derivatives.displayBuffer, {
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
      upsert: isReplacement,
    });

    await storage.putObject(thumbnailKey, derivatives.thumbnailBuffer, {
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
      upsert: isReplacement,
    });

    // Delete quarantine object
    await storage.deleteObject(intent.quarantineKey).catch(() => {});
  } catch (err) {
    console.error('[STORAGE FINALIZATION ERROR]', err);
    return jsonError('Failed to store processed assets', 500, 'STORAGE_WRITE_FAILED');
  }

  // 10. Persist asset record & mark achievement ready & mark intent consumed atomically
  const assetId = crypto.randomUUID();
  let createdAsset: typeof assets.$inferSelect | undefined;
  let readyAchievement: Achievement | undefined;

  await db.transaction(async (tx) => {
    if (isReplacement) {
      await tx.delete(assets).where(eq(assets.achievementId, achievementId));
    }

    [createdAsset] = await tx
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

    [readyAchievement] = await tx
      .update(achievements)
      .set({
        state: 'ready',
        updatedAt: new Date(),
      })
      .where(eq(achievements.id, achievementId))
      .returning();

    await tx
      .update(uploadIntents)
      .set({
        status: 'consumed',
        achievementId,
      })
      .where(eq(uploadIntents.id, intent.id));
  });

  // 11. Best-effort removal of objects that are no longer referenced. Keys that
  // were overwritten in place are skipped; only genuinely orphaned keys remain.
  const currentKeys = new Set([originalKey, displayKey, thumbnailKey]);
  const orphanedKeys = staleKeys.filter((key) => !currentKeys.has(key));
  if (orphanedKeys.length > 0) {
    await storage.deleteObjects(orphanedKeys).catch(() => {});
  }

  return jsonResponse({
    finalized: true,
    achievement: readyAchievement ?? achievementRecord,
    asset: {
      id: createdAsset?.id ?? assetId,
      width: validated.width,
      height: validated.height,
      originalBytes: validated.byteLength,
      mimeType: validated.mimeType,
      checksum: validated.checksum,
    },
  });
}
