import { and, eq } from 'drizzle-orm';
import { getDb, type AppDatabase } from '@/lib/db';
import {
  achievements,
  assets,
  uploadIntents,
  type Achievement,
  type Asset,
  type RetiredObject,
  type UploadIntent,
} from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MAX_DERIVATIVE_BOUND_BYTES, RESERVED_BYTES_PER_INTENT } from '@/lib/storage/quota';
import { validateImageBuffer, ImageValidationError } from '@/lib/image/validator';
import { processImageDerivatives } from '@/lib/image/processor';
import {
  validateTitle,
  validateCompletionDate,
  validateNotes,
  validateTags,
  ValidationError,
} from '@/lib/validation/achievement';

export type FinalizeRequestBody = Record<string, unknown>;

export interface FinalizedAsset {
  id: string;
  width: number;
  height: number;
  originalBytes: number;
  mimeType: string;
  checksum: string;
}

export interface FinalizeSuccess {
  finalized: true;
  achievement: Achievement;
  asset: FinalizedAsset;
}

export type FinalizeResult =
  | { ok: true; payload: FinalizeSuccess }
  | { ok: false; status: number; code: string; message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, code: string, message: string): FinalizeResult {
  return { ok: false, status, code, message };
}

/**
 * Trashed and deleting records must not receive artwork or appear in a replay.
 */
function unavailableTarget(row: { state: string; trashedAt: Date | null }): FinalizeResult | null {
  if (row.state === 'deleting') {
    return fail(
      409,
      'ACHIEVEMENT_DELETING',
      'Achievement is being deleted and cannot receive new artwork'
    );
  }
  if (row.trashedAt) {
    return fail(
      409,
      'ACHIEVEMENT_TRASHED',
      'This artwork is in Trash. Restore it before replacing its image.'
    );
  }
  return null;
}

/**
 * Reads the optional target artwork from the request body. A malformed value is
 * rejected here so a database cast error can never surface as a 500.
 */
function requestedAchievementId(body: FinalizeRequestBody): { id: string | null; invalid: boolean } {
  const raw = body.achievementId;
  if (raw === undefined || raw === null || raw === '') return { id: null, invalid: false };
  if (typeof raw !== 'string') return { id: null, invalid: true };

  const trimmed = raw.trim().toLowerCase();
  if (!UUID_PATTERN.test(trimmed)) return { id: null, invalid: true };

  return { id: trimmed, invalid: false };
}

function assetPayload(asset: Asset): FinalizedAsset {
  return {
    id: asset.id,
    width: asset.width,
    height: asset.height,
    originalBytes: asset.originalBytes,
    mimeType: asset.mimeType,
    checksum: asset.checksum,
  };
}

class FinalizeAbort extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'FinalizeAbort';
  }
}

// Intents are serialized in-process as well as under a database row lock. The
// lock is what protects a pooled production deployment; the in-process chain
// also keeps the single-connection PGlite development database from
// interleaving two transactions for the same intent.
const intentWorkChains = new Map<string, Promise<unknown>>();

async function withIntentLock<T>(intentId: string, work: () => Promise<T>): Promise<T> {
  const previous = intentWorkChains.get(intentId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => undefined);
  intentWorkChains.set(intentId, tail);
  try {
    return await run;
  } finally {
    if (intentWorkChains.get(intentId) === tail) {
      intentWorkChains.delete(intentId);
    }
  }
}

type IntentState =
  | { kind: 'pending'; intent: UploadIntent }
  | { kind: 'replay'; intent: UploadIntent }
  | { kind: 'failed'; result: FinalizeResult };

type Binding =
  | { kind: 'bound'; intent: UploadIntent; achievementId: string; existingAsset: Asset | null }
  | { kind: 'replay'; intent: UploadIntent }
  | { kind: 'failed'; result: FinalizeResult };

/** Checks the intent's state under its row lock without creating anything. */
async function loadIntentState(db: AppDatabase, intentId: string): Promise<IntentState> {
  return db.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId))
      .for('update');

    if (!intent) {
      return { kind: 'failed', result: fail(404, 'NOT_FOUND', 'Upload intent not found') };
    }

    if (intent.status === 'consumed') {
      return { kind: 'replay', intent };
    }

    if (intent.status === 'cleaned') {
      return {
        kind: 'failed',
        result: fail(410, 'INTENT_CLEANED', 'Upload intent was already cleaned and cannot be promoted'),
      };
    }

    if (intent.status === 'expired' || Date.now() > intent.expiresAt.getTime()) {
      if (intent.status !== 'expired') {
        await tx
          .update(uploadIntents)
          .set({ status: 'expired' })
          .where(eq(uploadIntents.id, intent.id));
      }
      return {
        kind: 'failed',
        result: fail(410, 'INTENT_EXPIRED', 'Upload intent has expired and cannot be promoted'),
      };
    }

    return { kind: 'pending', intent };
  });
}

/**
 * Durably binds the intent to exactly one achievement before any permanent
 * object is written. The re-read happens under the row lock, so a concurrent
 * first call reuses the bound record instead of allocating a second one.
 */
async function bindIntent(
  db: AppDatabase,
  intentId: string,
  body: FinalizeRequestBody
): Promise<Binding> {
  try {
    return await db.transaction(async (tx) => {
      const [intent] = await tx
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intentId))
        .for('update');

      if (!intent) {
        return { kind: 'failed', result: fail(404, 'NOT_FOUND', 'Upload intent not found') };
      }

      if (intent.status === 'consumed') {
        return { kind: 'replay', intent };
      }

      if (intent.status !== 'pending' || Date.now() > intent.expiresAt.getTime()) {
        return {
          kind: 'failed',
          result: fail(409, 'INTENT_NOT_PENDING', 'This upload intent is no longer pending. Retry with a new upload.'),
        };
      }

      const requested = requestedAchievementId(body);
      if (requested.invalid) {
        return {
          kind: 'failed',
          result: fail(400, 'INVALID_INPUT', 'achievementId must be a valid artwork ID.'),
        };
      }
      const requestedId = requested.id;

      if (intent.achievementId) {
        if (requestedId && requestedId !== intent.achievementId) {
          return {
            kind: 'failed',
            result: fail(
              409,
              'INTENT_ALREADY_BOUND',
              'This upload intent is already bound to a different artwork.'
            ),
          };
        }

        const [row] = await tx
          .select()
          .from(achievements)
          .where(eq(achievements.id, intent.achievementId))
          .for('update');

        if (!row) {
          return { kind: 'failed', result: fail(404, 'NOT_FOUND', 'Linked achievement not found') };
        }
        const blocked = unavailableTarget(row);
        if (blocked) return { kind: 'failed', result: blocked };

        const [existingAsset] = await tx
          .select()
          .from(assets)
          .where(eq(assets.achievementId, intent.achievementId));

        return {
          kind: 'bound',
          intent,
          achievementId: intent.achievementId,
          existingAsset: existingAsset ?? null,
        };
      }

      if (requestedId) {
        const [row] = await tx
          .select()
          .from(achievements)
          .where(eq(achievements.id, requestedId))
          .for('update');

        if (!row) {
          return { kind: 'failed', result: fail(404, 'NOT_FOUND', 'Linked achievement not found') };
        }
        const blocked = unavailableTarget(row);
        if (blocked) return { kind: 'failed', result: blocked };

        await tx
          .update(uploadIntents)
          .set({ achievementId: row.id })
          .where(eq(uploadIntents.id, intent.id));

        const [existingAsset] = await tx
          .select()
          .from(assets)
          .where(eq(assets.achievementId, row.id));

        return { kind: 'bound', intent, achievementId: row.id, existingAsset: existingAsset ?? null };
      }

      const now = new Date();
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

      const achievementId = crypto.randomUUID();
      await tx.insert(achievements).values({
        id: achievementId,
        title,
        completionDate,
        notes,
        tags,
        state: 'pending',
      });
      await tx
        .update(uploadIntents)
        .set({ achievementId })
        .where(eq(uploadIntents.id, intent.id));

      return { kind: 'bound', intent, achievementId, existingAsset: null };
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return { kind: 'failed', result: fail(error.statusCode, error.code, error.message) };
    }
    throw error;
  }
}

/**
 * Removes the quarantine copy after the intent is consumed. A failure is
 * deliberately not fatal: the intent keeps its reservation counted until
 * maintenance confirms the removal.
 */
async function releaseQuarantine(
  db: AppDatabase,
  storage: ReturnType<typeof getStorage>,
  intent: UploadIntent
): Promise<void> {
  try {
    await storage.deleteObject(intent.quarantineKey);
  } catch (error) {
    console.warn('[UPLOAD QUARANTINE CLEANUP DEFERRED]', error);
    return;
  }

  await db
    .update(uploadIntents)
    .set({ quarantineCleanedAt: new Date() })
    .where(eq(uploadIntents.id, intent.id));
}

/**
 * Discards the bytes of an intent that failed validation. If the delete fails,
 * the intent is left non-retryable and still counted so maintenance can finish
 * the job instead of quietly leaking the file.
 */
async function discardQuarantine(
  db: AppDatabase,
  storage: ReturnType<typeof getStorage>,
  intent: UploadIntent
): Promise<void> {
  try {
    await storage.deleteObject(intent.quarantineKey);
    await db
      .update(uploadIntents)
      .set({ status: 'cleaned', quarantineCleanedAt: new Date(), permanentKeys: [] })
      .where(eq(uploadIntents.id, intent.id));
  } catch (error) {
    console.warn('[UPLOAD QUARANTINE CLEANUP FAILED]', error);
    await db
      .update(uploadIntents)
      .set({ status: 'expired' })
      .where(eq(uploadIntents.id, intent.id));
  }
}

/**
 * Removes superseded objects and drops their cleanup entries only once every
 * key is gone. Failed groups stay on the asset row and stay counted by quota.
 */
async function removeRetiredObjects(
  db: AppDatabase,
  storage: ReturnType<typeof getStorage>,
  assetId: string,
  retired: RetiredObject[]
): Promise<void> {
  if (retired.length === 0) return;

  const remaining: RetiredObject[] = [];
  for (const entry of retired) {
    try {
      await storage.deleteObjects(entry.keys);
    } catch {
      remaining.push(entry);
    }
  }

  if (remaining.length !== retired.length) {
    await db.update(assets).set({ retiredObjects: remaining }).where(eq(assets.id, assetId));
  }
}

async function buildReplay(db: AppDatabase, intent: UploadIntent): Promise<FinalizeResult> {
  if (!intent.achievementId) {
    return fail(404, 'REPLAY_TARGET_MISSING', 'This upload intent has no linked artwork.');
  }

  const [achievement] = await db
    .select()
    .from(achievements)
    .where(eq(achievements.id, intent.achievementId));
  const [asset] = await db
    .select()
    .from(assets)
    .where(eq(assets.achievementId, intent.achievementId));

  if (!achievement || !asset) {
    return fail(
      404,
      'REPLAY_TARGET_MISSING',
      'The artwork linked to this upload intent is no longer available.'
    );
  }

  const blocked = unavailableTarget(achievement);
  if (blocked) return blocked;

  return { ok: true, payload: { finalized: true, achievement, asset: assetPayload(asset) } };
}

async function runFinalize(
  intentId: string,
  body: FinalizeRequestBody
): Promise<FinalizeResult> {
  const db = await getDb();
  const storage = getStorage();

  const state = await loadIntentState(db, intentId);
  if (state.kind === 'failed') return state.result;
  if (state.kind === 'replay') return buildReplay(db, state.intent);

  const intent = state.intent;

  let quarantine: Buffer;
  try {
    quarantine = (await storage.getObject(intent.quarantineKey)).data;
  } catch {
    return fail(
      400,
      'UPLOAD_NOT_FOUND',
      'Quarantined file not found in storage. Upload may not have completed.'
    );
  }

  let validated;
  try {
    validated = await validateImageBuffer(quarantine);
  } catch (error) {
    await discardQuarantine(db, storage, intent);
    if (error instanceof ImageValidationError) {
      return fail(error.statusCode, error.code, error.message);
    }
    return fail(400, 'CORRUPT_IMAGE', 'Image validation failed');
  }

  let derivatives;
  try {
    derivatives = await processImageDerivatives(quarantine);
  } catch (error) {
    console.error('[DERIVATIVE ERROR]', error);
    return fail(500, 'DERIVATIVE_PROCESSING_FAILED', 'Failed to generate image derivatives');
  }

  if (
    derivatives.displayBuffer.length > MAX_DERIVATIVE_BOUND_BYTES ||
    derivatives.thumbnailBuffer.length > MAX_DERIVATIVE_BOUND_BYTES
  ) {
    return fail(
      413,
      'DERIVATIVE_TOO_LARGE',
      'Generated image derivatives exceed the per-artwork derivative bound.'
    );
  }

  const stagedBytes =
    validated.byteLength + derivatives.displayBuffer.length + derivatives.thumbnailBuffer.length;
  if (stagedBytes > RESERVED_BYTES_PER_INTENT) {
    return fail(
      413,
      'RESERVATION_EXCEEDED',
      'This artwork and its derivatives exceed the reserved upload allowance.'
    );
  }

  // Binding happens only after the bytes are known to be storable, so invalid or
  // oversized files never mint an artwork record.
  const binding = await bindIntent(db, intentId, body);
  if (binding.kind === 'failed') return binding.result;
  if (binding.kind === 'replay') return buildReplay(db, binding.intent);

  const achievementId = binding.achievementId;

  const ext =
    validated.mimeType === 'image/jpeg'
      ? 'jpg'
      : validated.mimeType === 'image/png'
        ? 'png'
        : 'webp';
  // Intent-specific immutable paths: a retry rewrites exactly the same keys, and
  // a replacement never collides with the artwork it supersedes.
  const originalKey = `originals/${achievementId}/${intent.id}/original.${ext}`;
  const displayKey = `derivatives/${achievementId}/${intent.id}/display.webp`;
  const thumbnailKey = `derivatives/${achievementId}/${intent.id}/thumb.webp`;
  const plannedKeys = [originalKey, displayKey, thumbnailKey];

  // The planned keys are durable before the first permanent write so a failed
  // attempt still leaves a reference maintenance can clean up.
  const claimed = await db
    .update(uploadIntents)
    .set({ permanentKeys: plannedKeys })
    .where(and(eq(uploadIntents.id, intent.id), eq(uploadIntents.status, 'pending')))
    .returning();

  if (!claimed[0]) {
    return fail(
      409,
      'INTENT_NOT_PENDING',
      'This upload intent changed while it was being finalized. Retry the finalize request.'
    );
  }

  try {
    await storage.putObject(originalKey, quarantine, {
      contentType: validated.mimeType,
      cacheControl: 'private, no-store',
      upsert: true,
    });
    await storage.putObject(displayKey, derivatives.displayBuffer, {
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
      upsert: true,
    });
    await storage.putObject(thumbnailKey, derivatives.thumbnailBuffer, {
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
      upsert: true,
    });
  } catch (error) {
    console.error('[STORAGE FINALIZATION ERROR]', error);
    return fail(500, 'STORAGE_WRITE_FAILED', 'Failed to store processed assets');
  }

  const newAssetId = crypto.randomUUID();
  let committed: { asset: Asset; achievement: Achievement };
  try {
    committed = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intent.id))
        .for('update');

      if (!locked || locked.status !== 'pending') {
        throw new FinalizeAbort(
          409,
          'INTENT_NOT_PENDING',
          'This upload intent was finalized by another request.'
        );
      }

      const [currentAsset] = await tx
        .select()
        .from(assets)
        .where(eq(assets.achievementId, achievementId));

      const retired: RetiredObject[] = currentAsset ? [...currentAsset.retiredObjects] : [];
      if (currentAsset) {
        const supersededKeys = [
          currentAsset.originalKey,
          currentAsset.displayKey,
          currentAsset.thumbnailKey,
        ].filter((key) => !plannedKeys.includes(key));

        if (supersededKeys.length > 0) {
          retired.push({
            keys: supersededKeys,
            accountedBytes: currentAsset.originalBytes + MAX_DERIVATIVE_BOUND_BYTES,
          });
        }

        await tx.delete(assets).where(eq(assets.id, currentAsset.id));
      }

      const [asset] = await tx
        .insert(assets)
        .values({
          id: newAssetId,
          achievementId,
          originalKey,
          displayKey,
          thumbnailKey,
          originalBytes: validated.byteLength,
          mimeType: validated.mimeType,
          width: validated.width,
          height: validated.height,
          checksum: validated.checksum,
          retiredObjects: retired,
        })
        .returning();

      const [achievement] = await tx
        .update(achievements)
        .set({ state: 'ready', updatedAt: new Date() })
        .where(eq(achievements.id, achievementId))
        .returning();

      await tx
        .update(uploadIntents)
        .set({ status: 'consumed', achievementId })
        .where(eq(uploadIntents.id, intent.id));

      if (!asset || !achievement) {
        throw new Error('Failed to commit finalized upload');
      }

      return { asset, achievement };
    });
  } catch (error) {
    if (error instanceof FinalizeAbort) {
      return fail(error.status, error.code, error.message);
    }
    console.error('[FINALIZE COMMIT ERROR]', error);
    return fail(500, 'FINALIZE_FAILED', 'Failed to record the finalized artwork');
  }

  // Quarantine is retained until the record, ready state, and consumed intent
  // commit above, so a retry can still read the bytes.
  await releaseQuarantine(db, storage, intent);
  await removeRetiredObjects(db, storage, committed.asset.id, committed.asset.retiredObjects);

  return {
    ok: true,
    payload: {
      finalized: true,
      achievement: committed.achievement,
      asset: assetPayload(committed.asset),
    },
  };
}

/**
 * Finalizes one direct upload. Creates the artwork record once per intent,
 * writes permanent objects at intent-specific keys, and is safe to retry for
 * the same intent after a lost response or a partial write.
 */
export async function finalizeUpload(
  intentId: string,
  body: FinalizeRequestBody = {}
): Promise<FinalizeResult> {
  return withIntentLock(intentId, () => runFinalize(intentId, body));
}
