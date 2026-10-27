import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, assets, achievements } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { POST as createAchievementHandler } from '@/app/api/achievements/route';
import {
  GET as getSingleHandler,
  PATCH as patchAchievementHandler,
  DELETE as deleteAchievementHandler,
} from '@/app/api/achievements/[id]/route';
import { GET as getAssetsHandler } from '@/app/api/achievements/[id]/assets/route';
import { DELETE as purgeAchievementHandler } from '@/app/api/achievements/[id]/purge/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestJpeg } from '../helpers/image-fixtures';

describe('Integration: Achievements CRUD & Signed Asset Reads', () => {
  beforeEach(async () => {
    await resetDatabase();
    const storage = getStorage();
    if (storage instanceof MemoryStorageAdapter) {
      storage.clear();
    }
  });

  async function setupIntentWithImage(): Promise<string> {
    const db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;
    const jpeg = await createTestJpeg(400, 400);

    const intentId = crypto.randomUUID();
    const quarantineKey = `quarantine/${intentId}.jpg`;
    await storage.putObject(quarantineKey, jpeg, { contentType: 'image/jpeg' });

    await db.insert(uploadIntents).values({
      id: intentId,
      tokenHash: 'test_token_hash',
      fileName: 'sunset.jpg',
      mimeType: 'image/jpeg',
      declaredSize: jpeg.length,
      reservedBytes: 12 * 1024 * 1024,
      quarantineKey,
      status: 'pending',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    return intentId;
  }

  describe('POST /api/achievements', () => {
    it('creates ready achievement with valid metadata and links intent', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const intentId = await setupIntentWithImage();

      const req = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Sunset Over the Ocean',
          completionDate: '2026-10-21',
          notes: 'Acrylic on wood panel.',
          tags: ['ocean', 'sunset', 'acrylic'],
          intentId,
        }),
      });

      const res = await createAchievementHandler(req);
      expect(res.status).toBe(201);

      const data = (await res.json()) as {
        id: string;
        title: string;
        state: string;
        asset: { id: string; width: number; height: number };
      };

      expect(data.id).toBeTruthy();
      expect(data.title).toBe('Sunset Over the Ocean');
      expect(data.state).toBe('ready');
      expect(data.asset.width).toBe(400);
      expect(data.asset.height).toBe(400);
    });

    it('rejects future completion dates relative to client timezone', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const intentId = await setupIntentWithImage();

      const req = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Future Piece',
          completionDate: '2099-12-31',
          timezone: 'America/New_York',
          intentId,
        }),
      });

      const res = await createAchievementHandler(req);
      expect(res.status).toBe(400);
      const data = (await res.json()) as { code: string };
      expect(data.code).toBe('INVALID_COMPLETION_DATE');
    });

    it('rejects title longer than 120 characters', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const intentId = await setupIntentWithImage();

      const req = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'A'.repeat(121),
          completionDate: '2026-10-20',
          intentId,
        }),
      });

      const res = await createAchievementHandler(req);
      expect(res.status).toBe(400);
      const data = (await res.json()) as { code: string };
      expect(data.code).toBe('TITLE_TOO_LONG');
    });

    it('rejects tags exceeding 10 items or 24 characters each', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const intentId = await setupIntentWithImage();

      // Too many tags
      const req1 = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Valid Title',
          completionDate: '2026-10-20',
          tags: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],
          intentId,
        }),
      });
      const res1 = await createAchievementHandler(req1);
      expect(res1.status).toBe(400);

      // Tag too long
      const req2 = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Valid Title',
          completionDate: '2026-10-20',
          tags: ['this_tag_is_way_longer_than_24_characters'],
          intentId,
        }),
      });
      const res2 = await createAchievementHandler(req2);
      expect(res2.status).toBe(400);
    });
  });

  describe('GET /api/achievements/[id]', () => {
    it('returns single ready achievement with asset details', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const intentId = await setupIntentWithImage();

      const createReq = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Forest Clearing',
          completionDate: '2026-10-19',
          notes: 'Watercolor study.',
          tags: ['watercolor', 'nature'],
          intentId,
        }),
      });
      const createRes = await createAchievementHandler(createReq);
      const { id } = (await createRes.json()) as { id: string };

      const getReq = new NextRequest(`http://localhost:3000/api/achievements/${id}`, {
        method: 'GET',
        headers,
      });
      const getRes = await getSingleHandler(getReq, { params: Promise.resolve({ id }) });

      expect(getRes.status).toBe(200);
      const data = (await getRes.json()) as { id: string; title: string; asset: { width: number } };
      expect(data.id).toBe(id);
      expect(data.title).toBe('Forest Clearing');
      expect(data.asset.width).toBe(400);
    });

    it('returns 404 on non-existent or deleting achievement', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const fakeId = crypto.randomUUID();

      const req = new NextRequest(`http://localhost:3000/api/achievements/${fakeId}`, {
        method: 'GET',
        headers,
      });
      const res = await getSingleHandler(req, { params: Promise.resolve({ id: fakeId }) });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/achievements/[id]', () => {
    it('updates title, notes, and tags without altering storage assets', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const intentId = await setupIntentWithImage();

      const createReq = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Original Title',
          completionDate: '2026-10-18',
          tags: ['initial'],
          intentId,
        }),
      });
      const createRes = await createAchievementHandler(createReq);
      const { id } = (await createRes.json()) as { id: string };

      // Update
      const patchReq = new NextRequest(`http://localhost:3000/api/achievements/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          title: 'Refined Title',
          notes: 'Added extra shading in pencil.',
          tags: ['initial', 'pencil', 'sketch'],
        }),
      });
      const patchRes = await patchAchievementHandler(patchReq, {
        params: Promise.resolve({ id }),
      });
      expect(patchRes.status).toBe(200);

      const updated = (await patchRes.json()) as { title: string; notes: string; tags: string[] };
      expect(updated.title).toBe('Refined Title');
      expect(updated.notes).toBe('Added extra shading in pencil.');
      expect(updated.tags).toEqual(['initial', 'pencil', 'sketch']);
    });
  });

  describe('DELETE /api/achievements/[id]', () => {
    it('moves artwork to Trash first and only then deletes it permanently', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const intentId = await setupIntentWithImage();

      const createReq = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'To Be Deleted',
          completionDate: '2026-10-15',
          intentId,
        }),
      });
      const createRes = await createAchievementHandler(createReq);
      const { id } = (await createRes.json()) as { id: string };

      // Verify asset exists in storage
      const storage = getStorage() as MemoryStorageAdapter;
      const db = await getDb();
      const [asset] = await db.select().from(assets).where(eq(assets.achievementId, id));
      expect(asset).toBeTruthy();
      expect(storage.hasObject(asset!.originalKey)).toBe(true);
      expect(storage.hasObject(asset!.displayKey)).toBe(true);
      expect(storage.hasObject(asset!.thumbnailKey)).toBe(true);

      // Execute Delete
      const deleteReq = new NextRequest(`http://localhost:3000/api/achievements/${id}`, {
        method: 'DELETE',
        headers,
      });
      const deleteRes = await deleteAchievementHandler(deleteReq, {
        params: Promise.resolve({ id }),
      });
      expect(deleteRes.status).toBe(200);
      expect((await deleteRes.json()) as Record<string, unknown>).toMatchObject({
        trashed: true,
        id,
      });

      // Verify immediately hidden from GET
      const getReq = new NextRequest(`http://localhost:3000/api/achievements/${id}`, {
        method: 'GET',
        headers,
      });
      const getRes = await getSingleHandler(getReq, { params: Promise.resolve({ id }) });
      expect(getRes.status).toBe(404);

      // Trash keeps every byte and record until a permanent delete.
      expect(storage.hasObject(asset!.originalKey)).toBe(true);
      expect(storage.hasObject(asset!.displayKey)).toBe(true);
      expect(storage.hasObject(asset!.thumbnailKey)).toBe(true);
      const [trashedAch] = await db.select().from(achievements).where(eq(achievements.id, id));
      expect(trashedAch?.trashedAt).toBeInstanceOf(Date);

      // Permanent deletion now requires the explicit purge action.
      const purgeRes = await purgeAchievementHandler(
        new NextRequest(`http://localhost:3000/api/achievements/${id}/purge`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id }) }
      );
      expect(purgeRes.status).toBe(200);

      expect(storage.hasObject(asset!.originalKey)).toBe(false);
      expect(storage.hasObject(asset!.displayKey)).toBe(false);
      expect(storage.hasObject(asset!.thumbnailKey)).toBe(false);

      const [dbAch] = await db.select().from(achievements).where(eq(achievements.id, id));
      expect(dbAch).toBeUndefined();
    });
  });

  describe('GET /api/achievements/[id]/assets', () => {
    it('returns short-lived signed URLs (<= 60s) with attachment header and private cache control', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const intentId = await setupIntentWithImage();

      const createReq = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Ocean Sunset Study',
          completionDate: '2026-10-21',
          intentId,
        }),
      });
      const createRes = await createAchievementHandler(createReq);
      const { id } = (await createRes.json()) as { id: string };

      const assetReq = new NextRequest(`http://localhost:3000/api/achievements/${id}/assets`, {
        method: 'GET',
        headers,
      });
      const assetRes = await getAssetsHandler(assetReq, { params: Promise.resolve({ id }) });

      expect(assetRes.status).toBe(200);

      // Verify private cache headers
      expect(assetRes.headers.get('cache-control')).toBe('private, no-store, no-cache, must-revalidate');

      const data = (await assetRes.json()) as {
        displayUrl: string;
        thumbUrl: string;
        originalDownloadUrl: string;
        expiresInSeconds: number;
      };

      // Strict <= 60 seconds lifetime
      expect(data.expiresInSeconds).toBeLessThanOrEqual(60);
      expect(data.displayUrl).toBeTruthy();
      expect(data.thumbUrl).toBeTruthy();
      expect(data.originalDownloadUrl).toBeTruthy();

      // Original download URL must have download attachment parameter
      expect(data.originalDownloadUrl).toContain('download=ocean-sunset-study');
    });
  });
});
