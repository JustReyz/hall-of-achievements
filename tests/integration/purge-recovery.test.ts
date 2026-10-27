import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { getStorageQuotaStats } from '@/lib/storage/quota';
import { runStorageMaintenance } from '@/lib/storage/maintenance';
import { POST as createAchievementHandler } from '@/app/api/achievements/route';
import { DELETE as deleteAchievementHandler } from '@/app/api/achievements/[id]/route';
import { POST as restoreHandler } from '@/app/api/achievements/[id]/restore/route';
import { DELETE as purgeHandler } from '@/app/api/achievements/[id]/purge/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestJpeg } from '../helpers/image-fixtures';

const BASE = 'http://localhost:3000';

async function createArtwork(
  headers: Record<string, string>,
  title: string,
  buffer?: Buffer
): Promise<{ id: string; keys: string[] }> {
  const db = await getDb();
  const storage = getStorage() as MemoryStorageAdapter;
  const jpeg = buffer ?? (await createTestJpeg(320, 240));
  const intentId = crypto.randomUUID();
  const quarantineKey = `quarantine/${intentId}.jpg`;
  await db.insert(uploadIntents).values({
    id: intentId,
    tokenHash: 'test_hash',
    fileName: 'recovery.jpg',
    mimeType: 'image/jpeg',
    declaredSize: jpeg.length,
    reservedBytes: 12 * 1024 * 1024,
    quarantineKey,
    status: 'pending',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  await storage.putObject(quarantineKey, jpeg, { contentType: 'image/jpeg' });

  const response = await createAchievementHandler(
    new NextRequest(`${BASE}/api/achievements`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, completionDate: '2026-10-20', intentId }),
    })
  );
  const created = (await response.json()) as { id: string };

  const [asset] = await db.select().from(assets).where(eq(assets.achievementId, created.id));
  return {
    id: created.id,
    keys: [asset!.originalKey, asset!.displayKey, asset!.thumbnailKey],
  };
}

async function trash(headers: Record<string, string>, id: string): Promise<void> {
  const response = await deleteAchievementHandler(
    new NextRequest(`${BASE}/api/achievements/${id}`, { method: 'DELETE', headers }),
    { params: Promise.resolve({ id }) }
  );
  expect(response.status).toBe(200);
}

async function purge(headers: Record<string, string>, id: string): Promise<Response> {
  return purgeHandler(
    new NextRequest(`${BASE}/api/achievements/${id}/purge`, { method: 'DELETE', headers }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(async () => {
  await resetDatabase();
  (getStorage() as MemoryStorageAdapter).clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Integration: reliable permanent deletion', () => {
  it('requires Trash before permanent deletion', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { id } = await createArtwork(headers, 'Not Trashed Yet');
    const storage = getStorage() as MemoryStorageAdapter;

    const response = await purge(headers, id);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('NOT_TRASHED');

    const [row] = await (await getDb()).select().from(achievements).where(eq(achievements.id, id));
    expect(row?.state).toBe('ready');
    expect(row?.trashedAt).toBeNull();
    expect(storage.getStoredCount()).toBeGreaterThan(0);
  });

  it('deletes objects before rows and reports completion', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { id, keys } = await createArtwork(headers, 'Clean Purge');
    const storage = getStorage() as MemoryStorageAdapter;
    await trash(headers, id);

    const response = await purge(headers, id);
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      deleted: true,
      id,
    });

    for (const key of keys) expect(storage.hasObject(key)).toBe(false);

    const db = await getDb();
    expect(await db.select().from(achievements)).toHaveLength(0);
    expect(await db.select().from(assets)).toHaveLength(0);

    const stats = await getStorageQuotaStats(db);
    expect(stats.committedBytes).toBe(0);
    expect(stats.retiredBytes).toBe(0);
  });

  it('keeps rows, keys, and counted bytes when the provider refuses deletion', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { id, keys } = await createArtwork(headers, 'Stuck Purge');
    const storage = getStorage() as MemoryStorageAdapter;
    await trash(headers, id);

    const db = await getDb();
    const before = await getStorageQuotaStats(db);

    vi.spyOn(storage, 'deleteObjects').mockRejectedValue(new Error('simulated provider failure'));

    const first = await purge(headers, id);
    expect(first.status).toBe(202);
    expect((await first.json()) as Record<string, unknown>).toMatchObject({
      deleted: false,
      pendingCleanup: true,
    });

    const [row] = await db.select().from(achievements).where(eq(achievements.id, id));
    expect(row?.state).toBe('deleting');
    expect(await db.select().from(assets)).toHaveLength(1);
    for (const key of keys) expect(storage.hasObject(key)).toBe(true);

    const after = await getStorageQuotaStats(db);
    expect(after.committedBytes).toBe(before.committedBytes);

    const trashRow = await (await import('@/app/api/trash/route')).GET(
      new NextRequest(`${BASE}/api/trash`, { headers })
    );
    expect(((await trashRow.json()) as { items: unknown[] }).items).toHaveLength(0);

    // Once the provider recovers, the same request converges.
    vi.restoreAllMocks();
    const retry = await purge(headers, id);
    expect(retry.status).toBe(200);
    for (const key of keys) expect(storage.hasObject(key)).toBe(false);
    expect(await db.select().from(achievements)).toHaveLength(0);
  });

  it('converges a partial deletion through maintenance', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { id, keys } = await createArtwork(headers, 'Maintenance Recovery');
    const storage = getStorage() as MemoryStorageAdapter;
    await trash(headers, id);

    const failing = vi
      .spyOn(storage, 'deleteObjects')
      .mockRejectedValueOnce(new Error('simulated provider failure'));

    expect((await purge(headers, id)).status).toBe(202);
    failing.mockRestore();

    const db = await getDb();
    const cleanup = await runStorageMaintenance(db, storage);
    expect(cleanup.cleanedAchievementsCount).toBe(1);

    expect(await db.select().from(achievements)).toHaveLength(0);
    for (const key of keys) expect(storage.hasObject(key)).toBe(false);
  });

  it('prevents a restore from clearing a claimed deleting state', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { id } = await createArtwork(headers, 'Race Piece');
    const storage = getStorage() as MemoryStorageAdapter;
    await trash(headers, id);

    vi.spyOn(storage, 'deleteObjects').mockRejectedValue(new Error('simulated provider failure'));
    expect((await purge(headers, id)).status).toBe(202);

    const restore = await restoreHandler(
      new NextRequest(`${BASE}/api/achievements/${id}/restore`, { method: 'POST', headers }),
      { params: Promise.resolve({ id }) }
    );
    expect(restore.status).toBe(409);
    expect(((await restore.json()) as { code: string }).code).toBe('ACHIEVEMENT_DELETING');

    const db = await getDb();
    const [row] = await db.select().from(achievements).where(eq(achievements.id, id));
    expect(row?.state).toBe('deleting');
    expect(row?.trashedAt).toBeInstanceOf(Date);
  });

  it('removes retired replacement objects during a permanent delete', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { id } = await createArtwork(headers, 'Replaced Then Deleted');
    const storage = getStorage() as MemoryStorageAdapter;
    const db = await getDb();

    const [oldAsset] = await db.select().from(assets).where(eq(assets.achievementId, id));
    const oldKeys = [oldAsset!.originalKey, oldAsset!.displayKey, oldAsset!.thumbnailKey];

    // Replace the artwork, then trash it, keeping a retired entry alive by failing
    // the post-commit cleanup once.
    const failing = vi
      .spyOn(storage, 'deleteObjects')
      .mockRejectedValueOnce(new Error('simulated provider failure'));

    const png = await createTestJpeg(200, 200);
    const replacementIntent = crypto.randomUUID();
    const quarantineKey = `quarantine/${replacementIntent}.jpg`;
    await db.insert(uploadIntents).values({
      id: replacementIntent,
      tokenHash: 'test_hash',
      fileName: 'replacement.jpg',
      mimeType: 'image/jpeg',
      declaredSize: png.length,
      reservedBytes: 12 * 1024 * 1024,
      quarantineKey,
      status: 'pending',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    await storage.putObject(quarantineKey, png, { contentType: 'image/jpeg' });

    const { POST: finalizeHandler } = await import('@/app/api/uploads/[id]/finalize/route');
    const replaced = await finalizeHandler(
      new NextRequest(`${BASE}/api/uploads/${replacementIntent}/finalize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ achievementId: id }),
      }),
      { params: { id: replacementIntent } }
    );
    expect(replaced.status).toBe(200);
    failing.mockRestore();

    const [assetWithRetired] = await db.select().from(assets).where(eq(assets.achievementId, id));
    expect(assetWithRetired?.retiredObjects.length).toBe(1);

    await trash(headers, id);
    expect((await purge(headers, id)).status).toBe(200);

    for (const key of oldKeys) expect(storage.hasObject(key)).toBe(false);
    expect(await db.select().from(achievements)).toHaveLength(0);
    expect(storage.getStoredCount()).toBe(0);
  });
});
