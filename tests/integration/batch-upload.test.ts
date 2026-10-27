import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { getStorageQuotaStats, RESERVED_BYTES_PER_INTENT } from '@/lib/storage/quota';
import { runStorageMaintenance } from '@/lib/storage/maintenance';
import { POST as intentHandler } from '@/app/api/uploads/intents/route';
import { POST as finalizeHandler } from '@/app/api/uploads/[id]/finalize/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestJpeg, createTestPng } from '../helpers/image-fixtures';

const BASE = 'http://localhost:3000';

interface FinalizePayload {
  finalized?: boolean;
  achievement?: { id: string; title: string; state: string };
  asset?: { id: string; width: number; height: number };
  code?: string;
  error?: string;
}

async function startUpload(
  headers: Record<string, string>,
  buffer: Buffer,
  name: string,
  mimeType: string
): Promise<{ intentId: string; quarantineKey: string }> {
  const response = await intentHandler(
    new NextRequest(`${BASE}/api/uploads/intents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fileName: name, mimeType, fileSize: buffer.length }),
    })
  );
  const payload = (await response.json()) as { intentId: string; quarantineKey: string };
  const storage = getStorage() as MemoryStorageAdapter;
  await storage.putObject(payload.quarantineKey, buffer, { contentType: mimeType });
  return payload;
}

async function finalize(
  headers: Record<string, string>,
  intentId: string,
  body: Record<string, unknown> = {}
): Promise<{ status: number; payload: FinalizePayload }> {
  const response = await finalizeHandler(
    new NextRequest(`${BASE}/api/uploads/${intentId}/finalize`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: intentId }) }
  );
  return { status: response.status, payload: (await response.json()) as FinalizePayload };
}

function memoryStorage(): MemoryStorageAdapter {
  return getStorage() as MemoryStorageAdapter;
}

beforeEach(async () => {
  await resetDatabase();
  memoryStorage().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Integration: batch upload finalization safety', () => {
  it('creates exactly one artwork and one asset for concurrent first finalizations', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(400, 300);
    const { intentId } = await startUpload(headers, jpeg, 'concurrent.jpg', 'image/jpeg');

    const [first, second] = await Promise.all([
      finalize(headers, intentId, { title: 'Concurrent Study', completionDate: '2026-10-01' }),
      finalize(headers, intentId, { title: 'Concurrent Study', completionDate: '2026-10-01' }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.payload.achievement?.id).toBe(second.payload.achievement?.id);

    const db = await getDb();
    const achievementRows = await db.select().from(achievements);
    expect(achievementRows).toHaveLength(1);

    const assetRows = await db.select().from(assets);
    expect(assetRows).toHaveLength(1);

    const [intent] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId));
    expect(intent?.status).toBe('consumed');
    expect(intent?.achievementId).toBe(achievementRows[0]?.id);
  });

  it('replays the intent-bound artwork and ignores a caller-supplied achievement ID', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(320, 240);

    const firstUpload = await startUpload(headers, jpeg, 'first.jpg', 'image/jpeg');
    const first = await finalize(headers, firstUpload.intentId, { title: 'First Piece' });
    const firstId = first.payload.achievement!.id;

    const secondUpload = await startUpload(headers, jpeg, 'second.jpg', 'image/jpeg');
    const second = await finalize(headers, secondUpload.intentId, { title: 'Second Piece' });
    const secondId = second.payload.achievement!.id;

    const replay = await finalize(headers, firstUpload.intentId, { achievementId: secondId });

    expect(replay.status).toBe(200);
    expect(replay.payload.achievement?.id).toBe(firstId);
    expect(replay.payload.asset?.id).toBe(first.payload.asset?.id);

    const db = await getDb();
    expect(await db.select().from(achievements)).toHaveLength(2);
    expect(await db.select().from(assets)).toHaveLength(2);
  });

  it('replays a lost finalize response without minting a second record', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(300, 300);
    const { intentId } = await startUpload(headers, jpeg, 'lost.docx.jpg', 'image/jpeg');

    const first = await finalize(headers, intentId, { title: 'Lost Response' });
    expect(first.status).toBe(200);

    // The client never saw the response, so it retries the same intent.
    const retry = await finalize(headers, intentId);

    expect(retry.status).toBe(200);
    expect(retry.payload.achievement?.id).toBe(first.payload.achievement?.id);
    expect(retry.payload.asset?.id).toBe(first.payload.asset?.id);

    const db = await getDb();
    expect(await db.select().from(achievements)).toHaveLength(1);
    expect(await db.select().from(assets)).toHaveLength(1);
  });

  it('keeps durable key references after a partial permanent write and finalizes on retry', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(360, 280);
    const { intentId } = await startUpload(headers, jpeg, 'partial.jpg', 'image/jpeg');
    const storage = memoryStorage();
    const realPut = storage.putObject.bind(storage);

    let failDisplay = true;
    const putSpy = vi.spyOn(storage, 'putObject').mockImplementation(async (key, data, options) => {
      if (failDisplay && key.includes('display.webp')) {
        throw new Error('simulated provider write failure');
      }
      return realPut(key, data, options);
    });

    const failed = await finalize(headers, intentId, { title: 'Partial Write' });
    expect(failed.status).toBe(500);
    expect(failed.payload.code).toBe('STORAGE_WRITE_FAILED');

    const db = await getDb();
    const [pendingIntent] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId));
    expect(pendingIntent?.status).toBe('pending');
    expect(pendingIntent?.permanentKeys).toHaveLength(3);

    const pendingAchievements = await db.select().from(achievements);
    expect(pendingAchievements).toHaveLength(1);
    expect(pendingAchievements[0]?.state).toBe('pending');
    expect(await db.select().from(assets)).toHaveLength(0);

    // The retry reuses the recorded keys instead of inventing new ones.
    failDisplay = false;
    const retried = await finalize(headers, intentId, { title: 'Partial Write' });
    expect(retried.status).toBe(200);

    const [consumedIntent] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId));
    expect(consumedIntent?.status).toBe('consumed');

    const [asset] = await db.select().from(assets);
    expect(asset?.originalKey).toContain(intentId);
    expect(consumedIntent?.permanentKeys).toEqual([
      asset!.originalKey,
      asset!.displayKey,
      asset!.thumbnailKey,
    ]);
    expect(putSpy).toHaveBeenCalled();
    expect(storage.getStoredCount()).toBe(3);
    expect(storage.hasObject(pendingIntent!.permanentKeys[0]!)).toBe(true);
  });

  it('cleans a bound pending achievement, partial keys, and quarantine of an expired intent', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(300, 220);
    const { intentId, quarantineKey } = await startUpload(headers, jpeg, 'abandoned.jpg', 'image/jpeg');
    const storage = memoryStorage();
    const realPut = storage.putObject.bind(storage);

    vi.spyOn(storage, 'putObject').mockImplementation(async (key, data, options) => {
      if (key.includes('display.webp')) throw new Error('simulated provider write failure');
      return realPut(key, data, options);
    });

    const failed = await finalize(headers, intentId, { title: 'Abandoned Attempt' });
    expect(failed.status).toBe(500);

    const db = await getDb();
    expect(await db.select().from(achievements)).toHaveLength(1);

    await db
      .update(uploadIntents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(uploadIntents.id, intentId));

    const cleanup = await runStorageMaintenance(db, storage);

    expect(cleanup.cleanedIntentsCount).toBe(1);
    const [intent] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId));
    expect(intent?.status).toBe('cleaned');
    expect(intent?.permanentKeys).toEqual([]);
    expect(intent?.quarantineCleanedAt).not.toBeNull();

    expect(await db.select().from(achievements)).toHaveLength(0);
    expect(await db.select().from(assets)).toHaveLength(0);
    expect(storage.hasObject(quarantineKey)).toBe(false);
    expect(storage.getStoredCount()).toBe(0);

    const stats = await getStorageQuotaStats(db);
    expect(stats.reservedBytes).toBe(0);
    expect(stats.orphanedQuarantineBytes).toBe(0);
  });

  it('retires superseded keys on replacement and removes them after the commit', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(400, 300);
    const png = await createTestPng(300, 200);
    const storage = memoryStorage();

    const initial = await startUpload(headers, jpeg, 'initial.jpg', 'image/jpeg');
    const created = await finalize(headers, initial.intentId, { title: 'Replaced Piece' });
    const achievementId = created.payload.achievement!.id;

    const db = await getDb();
    const [oldAsset] = await db.select().from(assets);
    expect(oldAsset).toBeTruthy();

    const replacement = await startUpload(headers, png, 'replacement.png', 'image/png');
    const replaced = await finalize(headers, replacement.intentId, { achievementId });

    expect(replaced.status).toBe(200);
    expect(replaced.payload.achievement?.id).toBe(achievementId);

    const [newAsset] = await db.select().from(assets);
    expect(newAsset?.originalKey).toContain(replacement.intentId);
    expect(newAsset?.originalKey).not.toBe(oldAsset!.originalKey);
    expect(newAsset?.retiredObjects).toEqual([]);

    expect(storage.hasObject(oldAsset!.originalKey)).toBe(false);
    expect(storage.hasObject(oldAsset!.displayKey)).toBe(false);
    expect(storage.hasObject(oldAsset!.thumbnailKey)).toBe(false);

    const stats = await getStorageQuotaStats(db);
    expect(stats.retiredBytes).toBe(0);
  });

  it('keeps and counts a superseded version when cleanup fails, then clears it on maintenance', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(400, 300);
    const png = await createTestPng(300, 200);
    const storage = memoryStorage();

    const initial = await startUpload(headers, jpeg, 'initial.jpg', 'image/jpeg');
    const created = await finalize(headers, initial.intentId, { title: 'Stubborn Cleanup' });
    const achievementId = created.payload.achievement!.id;

    const db = await getDb();
    const [oldAsset] = await db.select().from(assets);
    const oldKeys = [oldAsset!.originalKey, oldAsset!.displayKey, oldAsset!.thumbnailKey];

    const failingDelete = vi
      .spyOn(storage, 'deleteObjects')
      .mockImplementation(async (keys: string[]) => {
        if (keys.some((key) => oldKeys.includes(key))) {
          throw new Error('simulated provider delete failure');
        }
        for (const key of keys) storage.deleteObject(key);
      });

    const replacement = await startUpload(headers, png, 'replacement.png', 'image/png');
    const replaced = await finalize(headers, replacement.intentId, { achievementId });

    expect(replaced.status).toBe(200);
    const [assetWithRetired] = await db.select().from(assets);
    expect(assetWithRetired?.retiredObjects).toHaveLength(1);
    expect(assetWithRetired?.retiredObjects[0]?.keys).toEqual(oldKeys);

    const staleStats = await getStorageQuotaStats(db);
    expect(staleStats.retiredBytes).toBeGreaterThan(0);

    for (const key of oldKeys) {
      expect(storage.hasObject(key)).toBe(true);
    }

    failingDelete.mockRestore();
    const cleanup = await runStorageMaintenance(db, storage);

    expect(cleanup.cleanedRetiredGroupsCount).toBe(1);
    const [assetAfterCleanup] = await db.select().from(assets);
    expect(assetAfterCleanup?.retiredObjects).toEqual([]);
    for (const key of oldKeys) {
      expect(storage.hasObject(key)).toBe(false);
    }
    const stats = await getStorageQuotaStats(db);
    expect(stats.retiredBytes).toBe(0);
  });

  it('counts a quarantine file whose deletion failed until maintenance confirms removal', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(300, 300);
    const { intentId, quarantineKey } = await startUpload(headers, jpeg, 'leftover.jpg', 'image/jpeg');
    const storage = memoryStorage();
    const realDelete = storage.deleteObject.bind(storage);

    const failingQuarantine = vi
      .spyOn(storage, 'deleteObject')
      .mockImplementation(async (key: string) => {
        if (key === quarantineKey) throw new Error('simulated provider delete failure');
        return realDelete(key);
      });

    const finalized = await finalize(headers, intentId, { title: 'Leftover Quarantine' });
    expect(finalized.status).toBe(200);

    const db = await getDb();
    const [consumed] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId));
    expect(consumed?.status).toBe('consumed');
    expect(consumed?.quarantineCleanedAt).toBeNull();

    const stats = await getStorageQuotaStats(db);
    expect(stats.orphanedQuarantineBytes).toBe(RESERVED_BYTES_PER_INTENT);
    expect(stats.reservedBytes).toBe(RESERVED_BYTES_PER_INTENT);

    failingQuarantine.mockRestore();
    await runStorageMaintenance(db, storage);

    const [cleanedIntent] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId));
    expect(cleanedIntent?.quarantineCleanedAt).not.toBeNull();
    expect(storage.hasObject(quarantineKey)).toBe(false);

    const afterStats = await getStorageQuotaStats(db);
    expect(afterStats.orphanedQuarantineBytes).toBe(0);
    expect(afterStats.reservedBytes).toBe(0);
  });

  it('rejects a malformed target artwork ID instead of failing the request', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(240, 180);
    const { intentId } = await startUpload(headers, jpeg, 'bad-target.jpg', 'image/jpeg');

    const result = await finalize(headers, intentId, { achievementId: "' OR 1=1" });

    expect(result.status).toBe(400);
    expect(result.payload.code).toBe('INVALID_INPUT');

    const db = await getDb();
    expect(await db.select().from(achievements)).toHaveLength(0);
  });

  it('rejects a finalize retry that names a different artwork', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpeg = await createTestJpeg(300, 240);
    const first = await startUpload(headers, jpeg, 'bound.jpg', 'image/jpeg');
    const created = await finalize(headers, first.intentId, { title: 'Bound Piece' });
    expect(created.status).toBe(200);

    const other = await startUpload(headers, jpeg, 'other.jpg', 'image/jpeg');
    const otherCreated = await finalize(headers, other.intentId, { title: 'Other Piece' });
    expect(otherCreated.status).toBe(200);

    // A consumed intent replays its own artwork; a pending one refuses a mismatch.
    const secondPending = await startUpload(headers, jpeg, 'pending.jpg', 'image/jpeg');
    const db = await getDb();
    await db
      .update(uploadIntents)
      .set({ achievementId: created.payload.achievement!.id })
      .where(eq(uploadIntents.id, secondPending.intentId));

    const mismatch = await finalize(headers, secondPending.intentId, {
      achievementId: otherCreated.payload.achievement!.id,
    });

    expect(mismatch.status).toBe(409);
    expect(mismatch.payload.code).toBe('INTENT_ALREADY_BOUND');
  });
});
