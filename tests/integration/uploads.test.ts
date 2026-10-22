import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, assets, achievements } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { getStorageQuotaStats } from '@/lib/storage/quota';
import { POST as intentHandler } from '@/app/api/uploads/intents/route';
import { POST as finalizeHandler } from '@/app/api/uploads/[id]/finalize/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import {
  createTestJpeg,
  createTestPng,
  FAKE_SVG_BUFFER,
} from '../helpers/image-fixtures';

describe('Integration: Two-Phase Direct Upload & Finalization Protocol', () => {
  beforeEach(async () => {
    await resetDatabase();
    const storage = getStorage();
    if (storage instanceof MemoryStorageAdapter) {
      storage.clear();
    }
  });

  it('completes the full two-phase direct upload protocol successfully', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const jpegBuffer = await createTestJpeg(400, 300);

    // 1. Issue Upload Intent
    const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fileName: 'autumn_landscape.jpg',
        mimeType: 'image/jpeg',
        fileSize: jpegBuffer.length,
      }),
    });

    const intentRes = await intentHandler(intentReq);
    expect(intentRes.status).toBe(201);

    const intentData = (await intentRes.json()) as {
      intentId: string;
      uploadUrl: string;
      quarantineKey: string;
      reservedBytes: number;
    };

    expect(intentData.intentId).toBeTruthy();
    expect(intentData.quarantineKey).toContain('quarantine/');
    expect(intentData.reservedBytes).toBe(12 * 1024 * 1024);

    // 2. Direct Upload into Quarantine Path
    const storage = getStorage() as MemoryStorageAdapter;
    await storage.putObject(intentData.quarantineKey, jpegBuffer, {
      contentType: 'image/jpeg',
    });
    expect(storage.hasObject(intentData.quarantineKey)).toBe(true);

    // 3. Finalize Upload & Create Achievement
    const finalizeReq = new NextRequest(
      `http://localhost:3000/api/uploads/${intentData.intentId}/finalize`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Autumn Landscape in Oils',
          completionDate: '2026-10-20',
          notes: 'Painted on linen canvas with natural pigments.',
          tags: ['oil', 'autumn', 'landscape'],
        }),
      }
    );

    const finalizeRes = await finalizeHandler(finalizeReq, {
      params: Promise.resolve({ id: intentData.intentId }),
    });

    expect(finalizeRes.status).toBe(200);
    const finalizeData = (await finalizeRes.json()) as {
      finalized: boolean;
      achievement: {
        id: string;
        title: string;
        state: string;
      };
      asset: {
        id: string;
        width: number;
        height: number;
        originalBytes: number;
        checksum: string;
      };
    };

    expect(finalizeData.finalized).toBe(true);
    expect(finalizeData.achievement.title).toBe('Autumn Landscape in Oils');
    expect(finalizeData.achievement.state).toBe('ready');
    expect(finalizeData.asset.width).toBe(400);
    expect(finalizeData.asset.height).toBe(300);

    // 4. Verify DB State: intent is consumed, asset exists, achievement is ready
    const db = await getDb();
    const [dbIntent] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentData.intentId));
    expect(dbIntent?.status).toBe('consumed');

    const [dbAsset] = await db
      .select()
      .from(assets)
      .where(eq(assets.achievementId, finalizeData.achievement.id));
    expect(dbAsset).toBeTruthy();

    // 5. Verify Storage State: quarantine is deleted, display and thumbnail exist
    expect(storage.hasObject(intentData.quarantineKey)).toBe(false);
    expect(storage.hasObject(dbAsset!.originalKey)).toBe(true);
    expect(storage.hasObject(dbAsset!.displayKey)).toBe(true);
    expect(storage.hasObject(dbAsset!.thumbnailKey)).toBe(true);
  });

  it('guarantees idempotent finalization replay without duplicate records', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const pngBuffer = await createTestPng(300, 300);

    // Create intent
    const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fileName: 'study.png',
        mimeType: 'image/png',
        fileSize: pngBuffer.length,
      }),
    });
    const intentRes = await intentHandler(intentReq);
    const { intentId, quarantineKey } = (await intentRes.json()) as {
      intentId: string;
      quarantineKey: string;
    };

    // Put into storage
    const storage = getStorage() as MemoryStorageAdapter;
    await storage.putObject(quarantineKey, pngBuffer, { contentType: 'image/png' });

    // Finalize Call 1
    const finalizeReq1 = new NextRequest(
      `http://localhost:3000/api/uploads/${intentId}/finalize`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Color Study No. 1',
          completionDate: '2026-10-21',
        }),
      }
    );
    const res1 = await finalizeHandler(finalizeReq1, {
      params: Promise.resolve({ id: intentId }),
    });
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as { achievement: { id: string } };

    // Finalize Call 2 (network retry simulation)
    const finalizeReq2 = new NextRequest(
      `http://localhost:3000/api/uploads/${intentId}/finalize`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Color Study No. 1',
        }),
      }
    );
    const res2 = await finalizeHandler(finalizeReq2, {
      params: Promise.resolve({ id: intentId }),
    });
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as { achievement: { id: string } };

    // Must return the exact same achievement ID
    expect(data2.achievement.id).toBe(data1.achievement.id);

    // Verify exactly 1 achievement exists in DB
    const db = await getDb();
    const allAchievements = await db.select().from(achievements);
    expect(allAchievements.length).toBe(1);
  });


  it('replaces the artwork of an existing achievement without duplicating assets', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const storage = getStorage() as MemoryStorageAdapter;
    const jpegBuffer = await createTestJpeg(400, 300);

    // 1. Create the achievement with an initial image
    const firstIntentRes = await intentHandler(
      new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({ fileName: 'first.jpg', mimeType: 'image/jpeg', fileSize: jpegBuffer.length }),
      })
    );
    const firstIntent = (await firstIntentRes.json()) as { intentId: string; quarantineKey: string };
    await storage.putObject(firstIntent.quarantineKey, jpegBuffer, { contentType: 'image/jpeg' });

    const firstFinalizeRes = await finalizeHandler(
      new NextRequest(`http://localhost:3000/api/uploads/${firstIntent.intentId}/finalize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Restored Piece', completionDate: '2026-10-22', tags: ['repair'] }),
      }),
      { params: Promise.resolve({ id: firstIntent.intentId }) }
    );
    expect(firstFinalizeRes.status).toBe(200);
    const firstFinalize = (await firstFinalizeRes.json()) as { achievement: { id: string } };
    const achievementId = firstFinalize.achievement.id;

    const db = await getDb();
    const [oldAsset] = await db.select().from(assets).where(eq(assets.achievementId, achievementId));
    expect(oldAsset).toBeTruthy();
    expect(storage.hasObject(oldAsset!.originalKey)).toBe(true);

    // 2. Re-attach a different image (different format, so the original key changes)
    const pngBuffer = await createTestPng(300, 200);
    const secondIntentRes = await intentHandler(
      new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({ fileName: 'replacement.png', mimeType: 'image/png', fileSize: pngBuffer.length }),
      })
    );
    const secondIntent = (await secondIntentRes.json()) as { intentId: string; quarantineKey: string };
    await storage.putObject(secondIntent.quarantineKey, pngBuffer, { contentType: 'image/png' });

    const replaceRes = await finalizeHandler(
      new NextRequest(`http://localhost:3000/api/uploads/${secondIntent.intentId}/finalize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ achievementId }),
      }),
      { params: Promise.resolve({ id: secondIntent.intentId }) }
    );
    expect(replaceRes.status).toBe(200);
    const replaceData = (await replaceRes.json()) as {
      finalized: boolean;
      achievement: { id: string; title: string; state: string };
      asset: { width: number; height: number };
    };
    expect(replaceData.finalized).toBe(true);
    expect(replaceData.achievement.id).toBe(achievementId);
    expect(replaceData.achievement.state).toBe('ready');
    expect(replaceData.asset.width).toBe(300);
    expect(replaceData.asset.height).toBe(200);

    // 3. Metadata is preserved and exactly one asset row remains
    const [updatedAchievement] = await db
      .select()
      .from(achievements)
      .where(eq(achievements.id, achievementId));
    expect(updatedAchievement?.title).toBe('Restored Piece');
    expect(updatedAchievement?.tags).toEqual(['repair']);

    const replacementAssets = await db.select().from(assets).where(eq(assets.achievementId, achievementId));
    expect(replacementAssets.length).toBe(1);
    const newAsset = replacementAssets[0]!;
    expect(newAsset.originalKey).toContain('original.png');
    expect(newAsset.width).toBe(300);

    // 4. The new objects are readable and the stale original was reclaimed
    expect(storage.hasObject(newAsset.originalKey)).toBe(true);
    expect(storage.hasObject(newAsset.displayKey)).toBe(true);
    expect(storage.hasObject(newAsset.thumbnailKey)).toBe(true);
    expect(storage.hasObject(oldAsset!.originalKey)).toBe(false);
  });

  it('rejects finalization of an expired upload intent with HTTP 410', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const db = await getDb();

    // Create expired intent directly in DB
    const expiredId = crypto.randomUUID();
    const pastDate = new Date(Date.now() - 60 * 1000); // 1 minute in the past
    await db.insert(uploadIntents).values({
      id: expiredId,
      tokenHash: 'some_hash',
      fileName: 'expired.jpg',
      mimeType: 'image/jpeg',
      declaredSize: 1024,
      reservedBytes: 12 * 1024 * 1024,
      quarantineKey: `quarantine/${expiredId}.jpg`,
      status: 'pending',
      expiresAt: pastDate,
    });

    const finalizeReq = new NextRequest(
      `http://localhost:3000/api/uploads/${expiredId}/finalize`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Expired Piece' }),
      }
    );

    const res = await finalizeHandler(finalizeReq, {
      params: Promise.resolve({ id: expiredId }),
    });

    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTENT_EXPIRED');
  });

  it('rejects invalid/disallowed bytes (e.g. SVG) during finalization and cleans quarantine', async () => {
    const { headers } = await createAuthenticatedHeaders();

    // Intent declared as image/png
    const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fileName: 'disguised.png',
        mimeType: 'image/png',
        fileSize: FAKE_SVG_BUFFER.length,
      }),
    });
    const intentRes = await intentHandler(intentReq);
    const { intentId, quarantineKey } = (await intentRes.json()) as {
      intentId: string;
      quarantineKey: string;
    };

    // Attacker uploads SVG to quarantine
    const storage = getStorage() as MemoryStorageAdapter;
    await storage.putObject(quarantineKey, FAKE_SVG_BUFFER, { contentType: 'image/png' });

    // Finalize
    const finalizeReq = new NextRequest(
      `http://localhost:3000/api/uploads/${intentId}/finalize`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Disguised SVG Attack' }),
      }
    );

    const finalizeRes = await finalizeHandler(finalizeReq, {
      params: Promise.resolve({ id: intentId }),
    });

    expect(finalizeRes.status).toBe(400);
    const body = (await finalizeRes.json()) as { code: string };
    expect(body.code).toBe('INVALID_FILE_FORMAT');

    // Verify quarantine object is purged
    expect(storage.hasObject(quarantineKey)).toBe(false);

    // Verify intent status updated to cleaned
    const db = await getDb();
    const [dbIntent] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId));
    expect(dbIntent?.status).toBe('cleaned');
  });

  it('rolls back intent to cleaned status and releases quota if signing fails', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const storage = getStorage() as MemoryStorageAdapter;

    // Spy or mock createSignedUploadUrl to reject
    const originalCreateSigned = storage.createSignedUploadUrl.bind(storage);
    storage.createSignedUploadUrl = async () => {
      throw new Error('Simulated storage provider error');
    };

    try {
      const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'rollback_test.jpg',
          mimeType: 'image/jpeg',
          fileSize: 1024,
        }),
      });

      const res = await intentHandler(intentReq);
      expect(res.status).toBe(500);

      // Verify DB intent row was rolled back to 'cleaned'
      const db = await getDb();
      const rows = await db.select().from(uploadIntents);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe('cleaned');

      // Verify quota is completely unencumbered (0 reserved bytes, 0 active intents)
      const stats = await getStorageQuotaStats(db);
      expect(stats.reservedBytes).toBe(0);
      expect(stats.activeIntentCount).toBe(0);
    } finally {
      storage.createSignedUploadUrl = originalCreateSigned;
    }
  });
});

