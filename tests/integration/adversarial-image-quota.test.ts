import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, assets, achievements } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { POST as intentHandler } from '@/app/api/uploads/intents/route';
import { POST as finalizeHandler } from '@/app/api/uploads/[id]/finalize/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import {
  createTestJpeg,
  FAKE_SVG_BUFFER,
  FAKE_GIF_BUFFER,
  FAKE_HTML_BUFFER,
  FAKE_PSD_BUFFER,
  TRUNCATED_JPEG_BUFFER,
} from '../helpers/image-fixtures';
import {
  getStorageCeilingBytes,
  RESERVED_BYTES_PER_INTENT,
  getStorageQuotaStats,
} from '@/lib/storage/quota';

describe('Adversarial Challenge: Milestone 2 Image Pipeline & Storage Quota Boundaries', () => {
  beforeEach(async () => {
    await resetDatabase();
    const storage = getStorage();
    if (storage instanceof MemoryStorageAdapter) {
      storage.clear();
    }
  });

  describe('1. Magic Byte Spoofing & Format Verification Boundaries', () => {
    it('rejects file with .jpg extension containing SVG XML (<svg xmlns="...">) with HTTP 400', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // Step 1: Create intent claiming to be a JPEG
      const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'trojan_vector.jpg',
          mimeType: 'image/jpeg',
          fileSize: FAKE_SVG_BUFFER.length,
        }),
      });
      const intentRes = await intentHandler(intentReq);
      expect(intentRes.status).toBe(201);
      const { intentId, quarantineKey } = (await intentRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      // Step 2: Attacker bypasses client validation and uploads raw SVG to quarantine
      const storage = getStorage() as MemoryStorageAdapter;
      await storage.putObject(quarantineKey, FAKE_SVG_BUFFER, { contentType: 'image/jpeg' });
      expect(storage.hasObject(quarantineKey)).toBe(true);

      // Step 3: Trigger server-side finalization
      const finalizeReq = new NextRequest(
        `http://localhost:3000/api/uploads/${intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'Trojan SVG disguised as JPEG' }),
        }
      );
      const finalizeRes = await finalizeHandler(finalizeReq, {
        params: Promise.resolve({ id: intentId }),
      });

      // Assertions: MUST be rejected with HTTP 400 and INVALID_FILE_FORMAT
      expect(finalizeRes.status).toBe(400);
      const resJson = (await finalizeRes.json()) as { code: string; message: string };
      expect(resJson.code).toBe('INVALID_FILE_FORMAT');

      // Quarantine MUST be purged
      expect(storage.hasObject(quarantineKey)).toBe(false);

      // Intent status MUST be transitioned to 'cleaned'
      const db = await getDb();
      const [intentRow] = await db
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intentId));
      expect(intentRow?.status).toBe('cleaned');

      // Zero achievements or assets minted
      const allAchievements = await db.select().from(achievements);
      expect(allAchievements.length).toBe(0);
    });

    it('rejects file with .png extension containing HTML (<!DOCTYPE html><html><body>) with HTTP 400', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // Step 1: Create intent claiming to be a PNG
      const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'malicious_xss.png',
          mimeType: 'image/png',
          fileSize: FAKE_HTML_BUFFER.length,
        }),
      });
      const intentRes = await intentHandler(intentReq);
      expect(intentRes.status).toBe(201);
      const { intentId, quarantineKey } = (await intentRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      // Step 2: Upload raw HTML containing script to quarantine
      const storage = getStorage() as MemoryStorageAdapter;
      await storage.putObject(quarantineKey, FAKE_HTML_BUFFER, { contentType: 'image/png' });

      // Step 3: Finalize
      const finalizeReq = new NextRequest(
        `http://localhost:3000/api/uploads/${intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'XSS HTML disguised as PNG' }),
        }
      );
      const finalizeRes = await finalizeHandler(finalizeReq, {
        params: Promise.resolve({ id: intentId }),
      });

      expect(finalizeRes.status).toBe(400);
      const resJson = (await finalizeRes.json()) as { code: string };
      expect(resJson.code).toBe('INVALID_FILE_FORMAT');
      expect(storage.hasObject(quarantineKey)).toBe(false);

      const db = await getDb();
      const [intentRow] = await db
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intentId));
      expect(intentRow?.status).toBe('cleaned');
    });

    it('rejects file containing GIF (GIF89a...) with HTTP 400', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'animated.gif.jpg',
          mimeType: 'image/jpeg',
          fileSize: FAKE_GIF_BUFFER.length,
        }),
      });
      const intentRes = await intentHandler(intentReq);
      expect(intentRes.status).toBe(201);
      const { intentId, quarantineKey } = (await intentRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      const storage = getStorage() as MemoryStorageAdapter;
      await storage.putObject(quarantineKey, FAKE_GIF_BUFFER, { contentType: 'image/jpeg' });

      const finalizeReq = new NextRequest(
        `http://localhost:3000/api/uploads/${intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'Disallowed GIF' }),
        }
      );
      const finalizeRes = await finalizeHandler(finalizeReq, {
        params: Promise.resolve({ id: intentId }),
      });

      expect(finalizeRes.status).toBe(400);
      const resJson = (await finalizeRes.json()) as { code: string };
      expect(resJson.code).toBe('INVALID_FILE_FORMAT');
      expect(storage.hasObject(quarantineKey)).toBe(false);
    });

    it('rejects file containing PSD (8BPS...) with HTTP 400', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'photoshop_source.png',
          mimeType: 'image/png',
          fileSize: FAKE_PSD_BUFFER.length,
        }),
      });
      const intentRes = await intentHandler(intentReq);
      expect(intentRes.status).toBe(201);
      const { intentId, quarantineKey } = (await intentRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      const storage = getStorage() as MemoryStorageAdapter;
      await storage.putObject(quarantineKey, FAKE_PSD_BUFFER, { contentType: 'image/png' });

      const finalizeReq = new NextRequest(
        `http://localhost:3000/api/uploads/${intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'PSD Attack' }),
        }
      );
      const finalizeRes = await finalizeHandler(finalizeReq, {
        params: Promise.resolve({ id: intentId }),
      });

      expect(finalizeRes.status).toBe(400);
      const resJson = (await finalizeRes.json()) as { code: string };
      expect(resJson.code).toBe('INVALID_FILE_FORMAT');
      expect(storage.hasObject(quarantineKey)).toBe(false);
    });

    it('rejects corrupt or truncated JPEG/PNG buffers as corrupt image with HTTP 400', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // Test truncated JPEG
      const intentReq1 = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'truncated.jpg',
          mimeType: 'image/jpeg',
          fileSize: TRUNCATED_JPEG_BUFFER.length,
        }),
      });
      const intentRes1 = await intentHandler(intentReq1);
      const { intentId: id1, quarantineKey: key1 } = (await intentRes1.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      const storage = getStorage() as MemoryStorageAdapter;
      await storage.putObject(key1, TRUNCATED_JPEG_BUFFER, { contentType: 'image/jpeg' });

      const finalizeReq1 = new NextRequest(
        `http://localhost:3000/api/uploads/${id1}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'Truncated JPEG' }),
        }
      );
      const finalizeRes1 = await finalizeHandler(finalizeReq1, {
        params: Promise.resolve({ id: id1 }),
      });

      expect(finalizeRes1.status).toBe(400);
      const resJson1 = (await finalizeRes1.json()) as { code: string };
      expect(resJson1.code).toBe('CORRUPT_IMAGE');
      expect(storage.hasObject(key1)).toBe(false);

      // Test corrupt PNG (valid 8-byte PNG header followed by truncated bytes)
      const corruptPng = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(16, 0),
      ]);
      const intentReq2 = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'truncated.png',
          mimeType: 'image/png',
          fileSize: corruptPng.length,
        }),
      });
      const intentRes2 = await intentHandler(intentReq2);
      const { intentId: id2, quarantineKey: key2 } = (await intentRes2.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      await storage.putObject(key2, corruptPng, { contentType: 'image/png' });

      const finalizeReq2 = new NextRequest(
        `http://localhost:3000/api/uploads/${id2}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'Truncated PNG' }),
        }
      );
      const finalizeRes2 = await finalizeHandler(finalizeReq2, {
        params: Promise.resolve({ id: id2 }),
      });

      expect(finalizeRes2.status).toBe(400);
      const resJson2 = (await finalizeRes2.json()) as { code: string };
      expect(resJson2.code).toBe('CORRUPT_IMAGE');
      expect(storage.hasObject(key2)).toBe(false);
    });
  });

  describe('2. Pixel and Size Limits Boundaries', () => {
    it('rejects decompression bomb with resolution > 20 MP (5000x5000 = 25 MP) with RESOLUTION_EXCEEDED', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // Create a genuine JPEG image with 5000x5000 = 25 MP resolution
      const bombBuffer = await sharp({
        create: {
          width: 5000,
          height: 5000,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .jpeg({ quality: 20 }) // low quality to keep byte size small (~100KB) while pixel count is 25 MP
        .toBuffer();

      expect(bombBuffer.length).toBeLessThan(2 * 1024 * 1024); // verify byte size is tiny

      // Step 1: Create intent
      const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'decompression_bomb.jpg',
          mimeType: 'image/jpeg',
          fileSize: bombBuffer.length,
        }),
      });
      const intentRes = await intentHandler(intentReq);
      expect(intentRes.status).toBe(201);
      const { intentId, quarantineKey } = (await intentRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      // Step 2: Upload bomb to quarantine
      const storage = getStorage() as MemoryStorageAdapter;
      await storage.putObject(quarantineKey, bombBuffer, { contentType: 'image/jpeg' });

      // Step 3: Attempt finalization
      const finalizeReq = new NextRequest(
        `http://localhost:3000/api/uploads/${intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: '25 MP Decompression Bomb' }),
        }
      );
      const finalizeRes = await finalizeHandler(finalizeReq, {
        params: Promise.resolve({ id: intentId }),
      });

      // Assertions: MUST fail with HTTP 400 and RESOLUTION_EXCEEDED
      expect(finalizeRes.status).toBe(400);
      const resJson = (await finalizeRes.json()) as { code: string; error: string };
      expect(resJson.code).toBe('RESOLUTION_EXCEEDED');
      expect(resJson.error).toContain('20 megapixel limit');

      // Quarantine purged, intent cleaned
      expect(storage.hasObject(quarantineKey)).toBe(false);
      const db = await getDb();
      const [intentRow] = await db
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intentId));
      expect(intentRow?.status).toBe('cleaned');
    });

    it('rejects files exceeding 10 MiB at intent creation and finalization with HTTP 400', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const oversizedBytes = 10 * 1024 * 1024 + 1; // 10 MiB + 1 byte

      // Sub-case A: Intent endpoint rejects declared size > 10 MiB
      const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'oversized_huge.jpg',
          mimeType: 'image/jpeg',
          fileSize: oversizedBytes,
        }),
      });
      const intentRes = await intentHandler(intentReq);
      expect(intentRes.status).toBe(400);
      const intentErr = (await intentRes.json()) as { code: string };
      expect(intentErr.code).toBe('FILE_TOO_LARGE');

      // Sub-case B: Finalize endpoint rejects buffer > 10 MiB even if intent declared a smaller size
      const validIntentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'underdeclared.jpg',
          mimeType: 'image/jpeg',
          fileSize: 1024, // attacker falsely declared 1024 bytes
        }),
      });
      const validIntentRes = await intentHandler(validIntentReq);
      expect(validIntentRes.status).toBe(201);
      const { intentId, quarantineKey } = (await validIntentRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      // Attacker puts an 11 MiB payload into quarantine
      const hugeBuffer = Buffer.alloc(oversizedBytes);
      hugeBuffer[0] = 0xff;
      hugeBuffer[1] = 0xd8;
      hugeBuffer[2] = 0xff; // valid JPEG header to pass magic check

      const storage = getStorage() as MemoryStorageAdapter;
      await storage.putObject(quarantineKey, hugeBuffer, { contentType: 'image/jpeg' });

      const finalizeReq = new NextRequest(
        `http://localhost:3000/api/uploads/${intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: '11 MiB Quarantined Buffer' }),
        }
      );
      const finalizeRes = await finalizeHandler(finalizeReq, {
        params: Promise.resolve({ id: intentId }),
      });

      expect(finalizeRes.status).toBe(400);
      const finalizeErr = (await finalizeRes.json()) as { code: string };
      expect(finalizeErr.code).toBe('FILE_TOO_LARGE');
      expect(storage.hasObject(quarantineKey)).toBe(false);
    });
  });

  describe('3. Storage Quota & Concurrency Boundaries', () => {
    it('allows exactly 3 active unconsumed upload intents; rejects 4th with HTTP 429', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // Create Intent 1
      const res1 = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({ fileName: 'art1.jpg', mimeType: 'image/jpeg', fileSize: 1000 }),
        })
      );
      expect(res1.status).toBe(201);
      const data1 = (await res1.json()) as { intentId: string };
      expect(data1.intentId).toBeTruthy();

      // Create Intent 2
      const res2 = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({ fileName: 'art2.jpg', mimeType: 'image/jpeg', fileSize: 1000 }),
        })
      );
      expect(res2.status).toBe(201);
      const data2 = (await res2.json()) as { intentId: string };
      expect(data2.intentId).toBeTruthy();

      // Create Intent 3
      const res3 = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({ fileName: 'art3.jpg', mimeType: 'image/jpeg', fileSize: 1000 }),
        })
      );
      expect(res3.status).toBe(201);
      const data3 = (await res3.json()) as { intentId: string };
      expect(data3.intentId).toBeTruthy();

      // Create Intent 4: MUST be rejected with HTTP 429 and TOO_MANY_CONCURRENT_INTENTS
      const res4 = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({ fileName: 'art4.jpg', mimeType: 'image/jpeg', fileSize: 1000 }),
        })
      );
      expect(res4.status).toBe(429);
      const data4 = (await res4.json()) as { code: string; error: string };
      expect(data4.code).toBe('TOO_MANY_CONCURRENT_INTENTS');
      expect(data4.error).toContain('Maximum of 3 active upload intents');
    });

    it('rejects upload intent reserving 12 MiB with HTTP 507 when storage quota is near 70% ceiling', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      const ceilingBytes = getStorageCeilingBytes();
      // Verify standard 70% ceiling of 1 GiB = 751,619,276 bytes
      expect(ceilingBytes).toBe(751_619_276);

      // Pre-fill committed storage near ceiling:
      // We want remainingCeilingBytes to be less than RESERVED_BYTES_PER_INTENT (12 MiB = 12,582,912 bytes).
      // Suppose we leave only 5 MiB available.
      const fiveMiB = 5 * 1024 * 1024;
      const targetCommitted = ceilingBytes - fiveMiB;
      // Committed bytes formula: assets.originalBytes + 2097152 (2MB bound)
      const originalBytesToInsert = targetCommitted - 2_097_152;

      // Seed dummy achievement and asset to fill storage
      const dummyAchId = crypto.randomUUID();
      await db.insert(achievements).values({
        id: dummyAchId,
        title: 'Quota Filler Achievement',
        completionDate: '2026-10-01',
        state: 'ready',
      });

      await db.insert(assets).values({
        id: crypto.randomUUID(),
        achievementId: dummyAchId,
        originalKey: 'originals/dummy.jpg',
        displayKey: 'derivatives/display.webp',
        thumbnailKey: 'derivatives/thumb.webp',
        originalBytes: originalBytesToInsert,
        mimeType: 'image/jpeg',
        width: 100,
        height: 100,
        checksum: 'dummychecksum',
      });

      // Verify quota metrics reflect pre-filled state
      const stats = await getStorageQuotaStats(db);
      expect(stats.remainingCeilingBytes).toBeLessThan(RESERVED_BYTES_PER_INTENT);
      expect(stats.totalAccountedBytes + RESERVED_BYTES_PER_INTENT).toBeGreaterThan(ceilingBytes);

      // Attempt to reserve upload intent (reserves 12 MiB)
      const res = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'rejected_by_quota.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1024,
          }),
        })
      );

      // Assertions: MUST fail with HTTP 507 STORAGE_QUOTA_EXCEEDED
      expect(res.status).toBe(507);
      const resJson = (await res.json()) as { code: string; error: string };
      expect(resJson.code).toBe('STORAGE_QUOTA_EXCEEDED');
      expect(resJson.error).toContain('Storage quota ceiling');
    });
  });

  describe('4. Finalize Idempotency Replay Boundary', () => {
    it('returns existing ready achievement with 200 OK without re-processing on finalize replay', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const testJpeg = await createTestJpeg(400, 300);

      // 1. Create upload intent
      const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'idempotent_masterpiece.jpg',
          mimeType: 'image/jpeg',
          fileSize: testJpeg.length,
        }),
      });
      const intentRes = await intentHandler(intentReq);
      expect(intentRes.status).toBe(201);
      const { intentId, quarantineKey } = (await intentRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      // 2. Put genuine JPEG into quarantine
      const storage = getStorage() as MemoryStorageAdapter;
      await storage.putObject(quarantineKey, testJpeg, { contentType: 'image/jpeg' });

      // 3. First Finalization Call
      const finalizeReq1 = new NextRequest(
        `http://localhost:3000/api/uploads/${intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: 'Initial Masterpiece',
            completionDate: '2026-10-22',
            notes: 'First creation note',
            tags: ['art', 'masterpiece'],
          }),
        }
      );
      const finalizeRes1 = await finalizeHandler(finalizeReq1, {
        params: Promise.resolve({ id: intentId }),
      });
      expect(finalizeRes1.status).toBe(200);
      const data1 = (await finalizeRes1.json()) as {
        finalized: boolean;
        achievement: { id: string; title: string; state: string };
        asset: { id: string; checksum: string; width: number; height: number };
      };

      expect(data1.finalized).toBe(true);
      expect(data1.achievement.state).toBe('ready');
      expect(data1.achievement.title).toBe('Initial Masterpiece');
      const initialAchId = data1.achievement.id;
      const initialAssetId = data1.asset.id;
      const initialChecksum = data1.asset.checksum;

      // 4. Replay Finalization Call (e.g. network retry or duplicate client POST)
      const finalizeReq2 = new NextRequest(
        `http://localhost:3000/api/uploads/${intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: 'Attempted Duplicate Title That Must Be Ignored',
          }),
        }
      );
      const finalizeRes2 = await finalizeHandler(finalizeReq2, {
        params: Promise.resolve({ id: intentId }),
      });

      expect(finalizeRes2.status).toBe(200);
      const data2 = (await finalizeRes2.json()) as {
        finalized: boolean;
        achievement: { id: string; title: string; state: string };
        asset: { id: string; checksum: string; width: number; height: number };
      };

      // Assertions: MUST return exactly the same achievement and asset records
      expect(data2.finalized).toBe(true);
      expect(data2.achievement.id).toBe(initialAchId);
      expect(data2.achievement.title).toBe('Initial Masterpiece'); // unchanged
      expect(data2.asset.id).toBe(initialAssetId);
      expect(data2.asset.checksum).toBe(initialChecksum);

      // Verify Database records: exactly 1 achievement, exactly 1 asset
      const db = await getDb();
      const dbAchievements = await db.select().from(achievements);
      expect(dbAchievements.length).toBe(1);

      const dbAssets = await db.select().from(assets);
      expect(dbAssets.length).toBe(1);

      const [dbIntent] = await db
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intentId));
      expect(dbIntent?.status).toBe('consumed');
      expect(dbIntent?.achievementId).toBe(initialAchId);
    });
  });
});
