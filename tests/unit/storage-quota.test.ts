import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, assets, achievements } from '@/lib/db/schema';
import {
  getStorageCeilingBytes,
  getStorageQuotaStats,
  reserveUploadQuota,
  RESERVED_BYTES_PER_INTENT,
} from '@/lib/storage/quota';
import { cleanExpiredUploadIntents } from '@/lib/storage/maintenance';
import { getStorage } from '@/lib/storage';

describe('Unit: Storage Quota & Capacity Reservation Engine', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('calculates the 70% storage ceiling correctly against provider allowance', () => {
    const ceiling = getStorageCeilingBytes();
    // Default 1 GiB = 1,073,741,824 bytes -> 70% is 751,619,276 bytes
    expect(ceiling).toBe(Math.floor(1024 * 1024 * 1024 * 0.70));
    expect(ceiling).toBe(751619276);
  });

  it('atomically reserves 12 MiB per upload intent', async () => {
    const db = await getDb();
    const tokenHash = 'test_session_hash_1';

    const intent = await reserveUploadQuota(db, {
      tokenHash,
      fileName: 'masterpiece.jpg',
      mimeType: 'image/jpeg',
      declaredSize: 4 * 1024 * 1024,
    });

    expect(intent.id).toBeTruthy();
    expect(intent.reservedBytes).toBe(RESERVED_BYTES_PER_INTENT);
    expect(intent.reservedBytes).toBe(12 * 1024 * 1024);
    expect(intent.status).toBe('pending');

    const stats = await getStorageQuotaStats(db);
    expect(stats.activeIntentCount).toBe(1);
    expect(stats.reservedBytes).toBe(12 * 1024 * 1024);
  });

  it('enforces maximum 3 concurrent active unconsumed upload intents', async () => {
    const db = await getDb();
    const tokenHash = 'test_session_hash_concurrency';

    // Create 3 intents successfully
    await reserveUploadQuota(db, {
      tokenHash,
      fileName: 'upload1.png',
      mimeType: 'image/png',
      declaredSize: 2 * 1024 * 1024,
    });
    await reserveUploadQuota(db, {
      tokenHash,
      fileName: 'upload2.png',
      mimeType: 'image/png',
      declaredSize: 3 * 1024 * 1024,
    });
    await reserveUploadQuota(db, {
      tokenHash,
      fileName: 'upload3.png',
      mimeType: 'image/png',
      declaredSize: 1 * 1024 * 1024,
    });

    const stats = await getStorageQuotaStats(db);
    expect(stats.activeIntentCount).toBe(3);

    // 4th concurrent intent must be rejected with HTTP 429
    await expect(
      reserveUploadQuota(db, {
        tokenHash,
        fileName: 'upload4.png',
        mimeType: 'image/png',
        declaredSize: 1 * 1024 * 1024,
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'TOO_MANY_CONCURRENT_INTENTS',
        statusCode: 429,
      })
    );
  });

  it('allows new intent once an existing intent is consumed or cleaned', async () => {
    const db = await getDb();
    const tokenHash = 'test_session_hash_reuse';

    const intent1 = await reserveUploadQuota(db, {
      tokenHash,
      fileName: 'art1.png',
      mimeType: 'image/png',
      declaredSize: 2 * 1024 * 1024,
    });
    await reserveUploadQuota(db, {
      tokenHash,
      fileName: 'art2.png',
      mimeType: 'image/png',
      declaredSize: 2 * 1024 * 1024,
    });
    await reserveUploadQuota(db, {
      tokenHash,
      fileName: 'art3.png',
      mimeType: 'image/png',
      declaredSize: 2 * 1024 * 1024,
    });

    // Mark intent 1 as consumed
    await db
      .update(uploadIntents)
      .set({ status: 'consumed' })
      .where(eq(uploadIntents.id, intent1.id));

    // Now active count is 2 -> creating 4th should succeed
    const intent4 = await reserveUploadQuota(db, {
      tokenHash,
      fileName: 'art4.png',
      mimeType: 'image/png',
      declaredSize: 2 * 1024 * 1024,
    });
    expect(intent4.id).toBeTruthy();
  });

  it('rejects intent with 507 when storage usage reaches 70% ceiling', async () => {
    const db = await getDb();
    const ceiling = getStorageCeilingBytes();

    // Insert an achievement and large asset row directly to simulate near-capacity storage
    const achId = crypto.randomUUID();
    await db.insert(achievements).values({
      id: achId,
      title: 'Massive Archive',
      completionDate: '2026-01-01',
      state: 'ready',
    });

    // Insert asset that occupies almost the entire 70% ceiling
    await db.insert(assets).values({
      id: crypto.randomUUID(),
      achievementId: achId,
      originalKey: 'originals/test.png',
      displayKey: 'display/test.webp',
      thumbnailKey: 'thumb/test.webp',
      // Leave only 5 MiB of remaining room before the 70% ceiling
      originalBytes: ceiling - (2 * 1024 * 1024) - (5 * 1024 * 1024),
      mimeType: 'image/png',
      width: 1000,
      height: 1000,
      checksum: 'fake_checksum',
    });

    // Attempting to reserve 12 MiB exceeds the remaining 5 MiB ceiling -> HTTP 507
    await expect(
      reserveUploadQuota(db, {
        tokenHash: 'test_token',
        fileName: 'overflow.png',
        mimeType: 'image/png',
        declaredSize: 4 * 1024 * 1024,
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'STORAGE_QUOTA_EXCEEDED',
        statusCode: 507,
      })
    );
  });

  it('reclaims expired upload intent reservations during maintenance', async () => {
    const db = await getDb();
    const storage = getStorage();

    // Create an expired intent in DB
    const expiredId = crypto.randomUUID();
    const pastDate = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago

    await db.insert(uploadIntents).values({
      id: expiredId,
      tokenHash: 'expired_session',
      fileName: 'old.jpg',
      mimeType: 'image/jpeg',
      declaredSize: 1024 * 1024,
      reservedBytes: RESERVED_BYTES_PER_INTENT,
      quarantineKey: `quarantine/${expiredId}.jpg`,
      status: 'pending',
      expiresAt: pastDate,
    });

    const cleanedCount = await cleanExpiredUploadIntents(db, storage);
    expect(cleanedCount).toBe(1);

    const [updated] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, expiredId));

    expect(updated?.status).toBe('cleaned');
  });
});
