import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { achievements, assets, uploadIntents } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { GET as galleryHandler, POST as createAchievementHandler } from '@/app/api/achievements/route';
import {
  GET as getSingleHandler,
  DELETE as deleteAchievementHandler,
} from '@/app/api/achievements/[id]/route';
import { GET as getAssetsHandler } from '@/app/api/achievements/[id]/assets/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestJpeg } from '../helpers/image-fixtures';

describe('Adversarial Stress Test: Milestone 2 Gallery Engine', () => {
  beforeEach(async () => {
    await resetDatabase();
    const storage = getStorage();
    if (storage instanceof MemoryStorageAdapter) {
      storage.clear();
    }
  });

  async function createHelperAchievement(title: string, date: string, tags: string[] = [], notes: string = '') {
    const db = await getDb();
    const id = crypto.randomUUID();
    await db.insert(achievements).values({
      id,
      title,
      completionDate: date,
      notes,
      tags,
      state: 'ready',
    });
    return id;
  }

  async function createHelperAchievementWithAssets(title: string = 'Test Art Piece') {
    const { headers } = await createAuthenticatedHeaders();
    const db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;
    const jpeg = await createTestJpeg(300, 300);

    const intentId = crypto.randomUUID();
    const quarantineKey = `quarantine/${intentId}.jpg`;
    await storage.putObject(quarantineKey, jpeg, { contentType: 'image/jpeg' });

    await db.insert(uploadIntents).values({
      id: intentId,
      tokenHash: 'adversarial_test_token_hash',
      fileName: 'adversarial.jpg',
      mimeType: 'image/jpeg',
      declaredSize: jpeg.length,
      reservedBytes: 12 * 1024 * 1024,
      quarantineKey,
      status: 'pending',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    const createReq = new NextRequest('http://localhost:3000/api/achievements', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title,
        completionDate: '2026-05-01',
        intentId,
        tags: ['adversarial', 'art'],
      }),
    });

    const createRes = await createAchievementHandler(createReq);
    expect(createRes.status).toBe(201);
    const data = (await createRes.json()) as { id: string };
    return { id: data.id, headers };
  }

  // =========================================================================
  // 1. DETERMINISTIC CURSOR PAGINATION WITH IDENTICAL DATES
  // =========================================================================
  describe('1. Deterministic Cursor Pagination: Clustered Identical Dates', () => {
    it('paginates 50 items with heavy date collisions across page boundaries with 0 dupes & 0 skips', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const insertedIds = new Set<string>();

      // Populate 50 achievements with multiple identical dates:
      // Group 1: 20 items on '2026-05-10' (Page 1 will take all 20, plus 4 from Group 2)
      // Group 2: 15 items on '2026-05-09' (Crosses Page 1 & Page 2 boundary!)
      // Group 3: 10 items on '2026-05-08' (Within Page 2)
      // Group 4: 5 items on '2026-05-07'  (Crosses Page 2 & Page 3 boundary: 3 on Page 2, 2 on Page 3)
      const dateClusters = [
        { date: '2026-05-10', count: 20 },
        { date: '2026-05-09', count: 15 },
        { date: '2026-05-08', count: 10 },
        { date: '2026-05-07', count: 5 },
      ];

      for (const cluster of dateClusters) {
        for (let i = 0; i < cluster.count; i++) {
          const id = await createHelperAchievement(
            `Artwork on ${cluster.date} #${i + 1}`,
            cluster.date,
            [`group-${cluster.date}`]
          );
          insertedIds.add(id);
        }
      }

      expect(insertedIds.size).toBe(50);

      // --- Page 1 (24 items) ---
      const req1 = new NextRequest('http://localhost:3000/api/achievements?limit=24', {
        method: 'GET',
        headers,
      });
      const res1 = await galleryHandler(req1);
      expect(res1.status).toBe(200);

      const page1 = (await res1.json()) as {
        items: Array<{ id: string; completionDate: string }>;
        nextCursor: string | null;
        hasMore: boolean;
      };

      expect(page1.items.length).toBe(24);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeTruthy();

      // Verify Page 1 composition: 20 from 2026-05-10, 4 from 2026-05-09
      const p1Dates = page1.items.map((it) => it.completionDate);
      expect(p1Dates.filter((d) => d === '2026-05-10').length).toBe(20);
      expect(p1Dates.filter((d) => d === '2026-05-09').length).toBe(4);

      // --- Page 2 (24 items) ---
      const req2 = new NextRequest(
        `http://localhost:3000/api/achievements?limit=24&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        { method: 'GET', headers }
      );
      const res2 = await galleryHandler(req2);
      expect(res2.status).toBe(200);

      const page2 = (await res2.json()) as {
        items: Array<{ id: string; completionDate: string }>;
        nextCursor: string | null;
        hasMore: boolean;
      };

      expect(page2.items.length).toBe(24);
      expect(page2.hasMore).toBe(true);
      expect(page2.nextCursor).toBeTruthy();

      // Verify Page 2 composition: remaining 11 from 2026-05-09, all 10 from 2026-05-08, 3 from 2026-05-07
      const p2Dates = page2.items.map((it) => it.completionDate);
      expect(p2Dates.filter((d) => d === '2026-05-09').length).toBe(11);
      expect(p2Dates.filter((d) => d === '2026-05-08').length).toBe(10);
      expect(p2Dates.filter((d) => d === '2026-05-07').length).toBe(3);

      // --- Page 3 (Remaining 2 items) ---
      const req3 = new NextRequest(
        `http://localhost:3000/api/achievements?limit=24&cursor=${encodeURIComponent(page2.nextCursor!)}`,
        { method: 'GET', headers }
      );
      const res3 = await galleryHandler(req3);
      expect(res3.status).toBe(200);

      const page3 = (await res3.json()) as {
        items: Array<{ id: string; completionDate: string }>;
        nextCursor: string | null;
        hasMore: boolean;
      };

      expect(page3.items.length).toBe(2);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();

      // Verify Page 3 composition: remaining 2 from 2026-05-07
      const p3Dates = page3.items.map((it) => it.completionDate);
      expect(p3Dates.every((d) => d === '2026-05-07')).toBe(true);

      // --- Check Integrity: Zero Duplicates & Zero Skips ---
      const allCollectedIds = [
        ...page1.items.map((it) => it.id),
        ...page2.items.map((it) => it.id),
        ...page3.items.map((it) => it.id),
      ];

      expect(allCollectedIds.length).toBe(50);
      const uniqueCollected = new Set(allCollectedIds);
      expect(uniqueCollected.size).toBe(50);
      expect(uniqueCollected).toEqual(insertedIds);

      // Verify strict descending sort: completionDate DESC, then id DESC
      for (let i = 0; i < allCollectedIds.length - 1; i++) {
        const curr = [...page1.items, ...page2.items, ...page3.items][i]!;
        const next = [...page1.items, ...page2.items, ...page3.items][i + 1]!;
        if (curr.completionDate === next.completionDate) {
          expect(curr.id > next.id).toBe(true);
        } else {
          expect(curr.completionDate > next.completionDate).toBe(true);
        }
      }
    });

    it('handles adversarial cursor inputs safely without crashing', async () => {
      const { headers } = await createAuthenticatedHeaders();
      await createHelperAchievement('Safe Item', '2026-05-01');

      // Invalid format cursor (no underscore)
      const req1 = new NextRequest('http://localhost:3000/api/achievements?cursor=malformedcursor', {
        method: 'GET',
        headers,
      });
      const res1 = await galleryHandler(req1);
      expect(res1.status).toBe(200);

      // Adversarial SQL injection in cursor date & id
      const req2 = new NextRequest(
        "http://localhost:3000/api/achievements?cursor=2026-05-01_' OR '1'='1",
        { method: 'GET', headers }
      );
      const res2 = await galleryHandler(req2);
      // Either handled gracefully with 200 or safe 500 error, never arbitrary code execution
      expect([200, 400, 500]).toContain(res2.status);
    });
  });

  // =========================================================================
  // 2. SEARCH ROBUSTNESS & INJECTION ESCAPING
  // =========================================================================
  describe('2. Search Robustness: Regex Characters, SQL Injection & Unicode', () => {
    let regexItemId: string;
    let sqlInjectItemId: string;
    let unicodeEmojiId: string;
    let unicodeCjkId: string;
    let unicodeArabicId: string;
    let unicodeAccentId: string;
    let regularItemId: string;

    beforeEach(async () => {
      regexItemId = await createHelperAchievement(
        'Special Regex: .*+?^${}()|[]\\',
        '2026-06-01',
        ['regex-meta']
      );
      sqlInjectItemId = await createHelperAchievement(
        "SQL Injection: ' OR 1=1; --",
        '2026-06-02',
        ['sqli-tag']
      );
      unicodeEmojiId = await createHelperAchievement(
        '🎨 Masterpiece 🌟 Highlight',
        '2026-06-03',
        ['✨', '🔥']
      );
      unicodeCjkId = await createHelperAchievement(
        '水墨画 伝統的な山水図',
        '2026-06-04',
        ['風景', '伝統']
      );
      unicodeArabicId = await createHelperAchievement(
        'فن الخط العربي والزخرفة الإسلامية',
        '2026-06-05',
        ['خط']
      );
      unicodeAccentId = await createHelperAchievement(
        'Café au Lait et Crème Brûlée',
        '2026-06-06',
        ['gastronomie']
      );
      regularItemId = await createHelperAchievement(
        'Standard Sunset Landscape',
        '2026-06-07',
        ['oil', 'sunset']
      );
      expect(regularItemId).toBeTruthy();
    });

    it('searches special regex characters without backslash as literals', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // Test regex chars without backslash: .*+?^${}()|[]
      const req = new NextRequest(
        'http://localhost:3000/api/achievements?q=' + encodeURIComponent('.*+?^${}()|[]'),
        { method: 'GET', headers }
      );
      const res = await galleryHandler(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as { items: Array<{ id: string; title: string }> };
      expect(data.items.length).toBe(1);
      expect(data.items[0]!.id).toBe(regexItemId);
    });

    it('escapes LIKE special characters (%, _, \\) when searching', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // 1. String containing trailing backslash: .*+?^${}()|[]\
      const reqSlash = new NextRequest(
        'http://localhost:3000/api/achievements?q=' + encodeURIComponent('.*+?^${}()|[]\\'),
        { method: 'GET', headers }
      );
      const resSlash = await galleryHandler(reqSlash);
      expect(resSlash.status).toBe(200);

      const dataSlash = (await resSlash.json()) as { items: Array<{ id: string; title: string }> };
      expect(dataSlash.items.length).toBe(1);
      expect(dataSlash.items[0]!.id).toBe(regexItemId);

      // 2. Wildcard neutralization: '%' should match only literal '%'
      const pctItem = await createHelperAchievement('Score: 100% Complete', '2026-06-08', ['rate%']);
      const otherItem = await createHelperAchievement('Score: 1000 Total', '2026-06-09', ['rate']);

      const reqPct = new NextRequest(
        'http://localhost:3000/api/achievements?q=' + encodeURIComponent('100%'),
        { method: 'GET', headers }
      );
      const resPct = await galleryHandler(reqPct);
      expect(resPct.status).toBe(200);
      const dataPct = (await resPct.json()) as { items: Array<{ id: string }> };
      const matchedIds = dataPct.items.map((i) => i.id);
      expect(matchedIds).toContain(pctItem);
      expect(matchedIds).not.toContain(otherItem);
    });

    it('safely neutralizes SQL injection attack payloads', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const injectionPayloads = [
        "' OR '1'='1",
        "' OR 1=1; --",
        "admin' --",
        "'; DROP TABLE achievements; --",
        "1' UNION SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL--",
      ];

      for (const payload of injectionPayloads) {
        const req = new NextRequest(
          'http://localhost:3000/api/achievements?q=' + encodeURIComponent(payload),
          { method: 'GET', headers }
        );
        const res = await galleryHandler(req);
        expect(res.status).toBe(200);

        const data = (await res.json()) as { items: Array<{ id: string; title: string }> };

        if (payload === "' OR 1=1; --") {
          // Exactly matches the item created with this exact literal string in its title
          expect(data.items.length).toBe(1);
          expect(data.items[0]!.id).toBe(sqlInjectItemId);
        } else {
          // All other injection strings must match zero items, not all 7 items!
          expect(data.items.length).toBe(0);
        }
      }

      // Verify database table was not dropped or compromised
      const db = await getDb();
      const allRows = await db.select().from(achievements);
      expect(allRows.length).toBe(7);
    });

    it('matches multibyte Unicode characters (Emoji, CJK, Arabic, Accents)', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // 1. Emoji search
      const emojiReq = new NextRequest(
        'http://localhost:3000/api/achievements?q=' + encodeURIComponent('🎨'),
        { method: 'GET', headers }
      );
      const emojiRes = await galleryHandler(emojiReq);
      expect(emojiRes.status).toBe(200);
      const emojiData = (await emojiRes.json()) as { items: Array<{ id: string }> };
      expect(emojiData.items.length).toBe(1);
      expect(emojiData.items[0]!.id).toBe(unicodeEmojiId);

      // 2. Emoji tag search: "🔥"
      const emojiTagReq = new NextRequest(
        'http://localhost:3000/api/achievements?q=' + encodeURIComponent('🔥'),
        { method: 'GET', headers }
      );
      const emojiTagRes = await galleryHandler(emojiTagReq);
      expect(emojiTagRes.status).toBe(200);
      const emojiTagData = (await emojiTagRes.json()) as { items: Array<{ id: string }> };
      expect(emojiTagData.items.length).toBe(1);
      expect(emojiTagData.items[0]!.id).toBe(unicodeEmojiId);

      // 3. CJK Kanji / Hanzi
      const cjkReq = new NextRequest(
        'http://localhost:3000/api/achievements?q=' + encodeURIComponent('山水図'),
        { method: 'GET', headers }
      );
      const cjkRes = await galleryHandler(cjkReq);
      expect(cjkRes.status).toBe(200);
      const cjkData = (await cjkRes.json()) as { items: Array<{ id: string }> };
      expect(cjkData.items.length).toBe(1);
      expect(cjkData.items[0]!.id).toBe(unicodeCjkId);

      // 4. Arabic Script
      const arabicReq = new NextRequest(
        'http://localhost:3000/api/achievements?q=' + encodeURIComponent('الخط العربي'),
        { method: 'GET', headers }
      );
      const arabicRes = await galleryHandler(arabicReq);
      expect(arabicRes.status).toBe(200);
      const arabicData = (await arabicRes.json()) as { items: Array<{ id: string }> };
      expect(arabicData.items.length).toBe(1);
      expect(arabicData.items[0]!.id).toBe(unicodeArabicId);

      // 5. French Accents: "Brûlée"
      const accentReq = new NextRequest(
        'http://localhost:3000/api/achievements?q=' + encodeURIComponent('Brûlée'),
        { method: 'GET', headers }
      );
      const accentRes = await galleryHandler(accentReq);
      expect(accentRes.status).toBe(200);
      const accentData = (await accentRes.json()) as { items: Array<{ id: string }> };
      expect(accentData.items.length).toBe(1);
      expect(accentData.items[0]!.id).toBe(unicodeAccentId);
    });

    it('treats empty and whitespace queries as unfiltered', async () => {
      const { headers } = await createAuthenticatedHeaders();

      for (const emptyQ of ['', '   ', '\t', '\n']) {
        const req = new NextRequest(
          'http://localhost:3000/api/achievements?q=' + encodeURIComponent(emptyQ),
          { method: 'GET', headers }
        );
        const res = await galleryHandler(req);
        expect(res.status).toBe(200);
        const data = (await res.json()) as { items: unknown[] };
        expect(data.items.length).toBe(7);
      }
    });
  });

  // =========================================================================
  // 3. TOMBSTONE-FIRST DELETION & STORAGE PURGE
  // =========================================================================
  describe('3. Tombstone-First Deletion: Immediate Concealment & Clean Storage Purge', () => {
    it('immediately hides deleting achievements from gallery and purges all assets', async () => {
      const { id, headers } = await createHelperAchievementWithAssets('Artwork To Be Destroyed');
      const storage = getStorage() as MemoryStorageAdapter;
      const db = await getDb();

      // Confirm asset keys exist
      const [asset] = await db.select().from(assets).where(eq(assets.achievementId, id));
      expect(asset).toBeTruthy();
      expect(storage.hasObject(asset!.originalKey)).toBe(true);
      expect(storage.hasObject(asset!.displayKey)).toBe(true);
      expect(storage.hasObject(asset!.thumbnailKey)).toBe(true);

      // Verify gallery currently returns it
      const beforeReq = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'GET',
        headers,
      });
      const beforeRes = await galleryHandler(beforeReq);
      const beforeData = (await beforeRes.json()) as { items: Array<{ id: string }> };
      expect(beforeData.items.some((it) => it.id === id)).toBe(true);

      // Step A: Simulate state transition to 'deleting' (tombstone)
      await db
        .update(achievements)
        .set({ state: 'deleting' })
        .where(eq(achievements.id, id));

      // Immediate concurrent query verification: gallery MUST conceal tombstoned item
      const midReq = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'GET',
        headers,
      });
      const midRes = await galleryHandler(midReq);
      const midData = (await midRes.json()) as { items: Array<{ id: string }> };
      expect(midData.items.some((it) => it.id === id)).toBe(false);

      // Individual GET must also reject tombstoned item
      const getReq = new NextRequest(`http://localhost:3000/api/achievements/${id}`, {
        method: 'GET',
        headers,
      });
      const getRes = await getSingleHandler(getReq, { params: Promise.resolve({ id }) });
      expect(getRes.status).toBe(404);

      // Asset GET must also reject tombstoned item
      const assetReq = new NextRequest(`http://localhost:3000/api/achievements/${id}/assets`, {
        method: 'GET',
        headers,
      });
      const assetRes = await getAssetsHandler(assetReq, { params: Promise.resolve({ id }) });
      expect(assetRes.status).toBe(404);

      // Step B: Now trigger official DELETE endpoint
      // Reset state back to 'ready' to test full DELETE route handler flow
      await db
        .update(achievements)
        .set({ state: 'ready' })
        .where(eq(achievements.id, id));

      const delReq = new NextRequest(`http://localhost:3000/api/achievements/${id}`, {
        method: 'DELETE',
        headers,
      });
      const delRes = await deleteAchievementHandler(delReq, { params: Promise.resolve({ id }) });
      expect(delRes.status).toBe(200);

      // Step C: Verify complete purge of storage objects
      expect(storage.hasObject(asset!.originalKey)).toBe(false);
      expect(storage.hasObject(asset!.displayKey)).toBe(false);
      expect(storage.hasObject(asset!.thumbnailKey)).toBe(false);

      // Step D: Verify permanent purge of DB rows
      const dbAchs = await db.select().from(achievements).where(eq(achievements.id, id));
      expect(dbAchs.length).toBe(0);

      const dbAssets = await db.select().from(assets).where(eq(assets.achievementId, id));
      expect(dbAssets.length).toBe(0);
    });

    it('safely handles idempotent deletion when storage objects are already missing', async () => {
      const { id, headers } = await createHelperAchievementWithAssets('Pre-Purged Artwork');
      const storage = getStorage() as MemoryStorageAdapter;
      const db = await getDb();

      const [asset] = await db.select().from(assets).where(eq(assets.achievementId, id));
      expect(asset).toBeTruthy();

      // Pre-delete storage objects manually
      await storage.deleteObjects([asset!.originalKey, asset!.displayKey, asset!.thumbnailKey]);
      expect(storage.hasObject(asset!.originalKey)).toBe(false);

      // DELETE endpoint must still succeed gracefully without 500 error
      const delReq = new NextRequest(`http://localhost:3000/api/achievements/${id}`, {
        method: 'DELETE',
        headers,
      });
      const delRes = await deleteAchievementHandler(delReq, { params: Promise.resolve({ id }) });
      expect(delRes.status).toBe(200);

      const [deleted] = await db.select().from(achievements).where(eq(achievements.id, id));
      expect(deleted).toBeUndefined();
    });
  });

  // =========================================================================
  // 4. SIGNED URL LIFETIME & CACHE-CONTROL HEADERS
  // =========================================================================
  describe('4. Signed URL Lifetime & Cache-Control Enforcement', () => {
    it('strictly restricts signed URL lifetime to <= 60 seconds with private no-cache headers', async () => {
      const { id, headers } = await createHelperAchievementWithAssets('Signed Asset Piece');

      const req = new NextRequest(`http://localhost:3000/api/achievements/${id}/assets`, {
        method: 'GET',
        headers,
      });
      const startTime = Date.now();
      const res = await getAssetsHandler(req, { params: Promise.resolve({ id }) });
      const endTime = Date.now();

      expect(res.status).toBe(200);

      // 1. Strict Cache-Control headers verification
      expect(res.headers.get('cache-control')).toBe('private, no-store, no-cache, must-revalidate');
      expect(res.headers.get('pragma')).toBe('no-cache');
      expect(res.headers.get('expires')).toBe('0');

      const data = (await res.json()) as {
        displayUrl: string;
        thumbUrl: string;
        originalDownloadUrl: string;
        expiresInSeconds: number;
        expiresAt: string;
      };

      // 2. Strict lifetime parameter <= 60 seconds
      expect(data.expiresInSeconds).toBeLessThanOrEqual(60);
      expect(data.expiresInSeconds).toBeGreaterThan(0);

      // 3. Verify signed URL expiration query parameters
      for (const [, signedUrl] of [
        ['displayUrl', data.displayUrl],
        ['thumbUrl', data.thumbUrl],
        ['originalDownloadUrl', data.originalDownloadUrl],
      ]) {
        expect(signedUrl).toBeTruthy();
        const parsed = new URL(signedUrl!, 'http://localhost:3000');
        const expiresParam = parsed.searchParams.get('expires');
        expect(expiresParam).toBeTruthy();

        const expiresTimestamp = parseInt(expiresParam!, 10);
        expect(isNaN(expiresTimestamp)).toBe(false);

        // Expiration must be in the future, bounded by startTime + 60s + tolerance
        expect(expiresTimestamp).toBeGreaterThan(startTime);
        expect(expiresTimestamp).toBeLessThanOrEqual(endTime + 60 * 1000 + 500);
      }

      // 4. Verify originalDownloadUrl includes download attachment filename parameter
      expect(data.originalDownloadUrl).toContain('download=signed-asset-piece');
    });

    it('enforces private cache headers and short-lived lifetime for single-type asset queries', async () => {
      const { id, headers } = await createHelperAchievementWithAssets('Individual Asset Type');

      for (const type of ['display', 'thumbnail', 'original']) {
        const req = new NextRequest(
          `http://localhost:3000/api/achievements/${id}/assets?type=${type}`,
          { method: 'GET', headers }
        );
        const res = await getAssetsHandler(req, { params: Promise.resolve({ id }) });
        expect(res.status).toBe(200);

        expect(res.headers.get('cache-control')).toBe('private, no-store, no-cache, must-revalidate');
        const data = (await res.json()) as { url: string; expiresInSeconds: number };
        expect(data.expiresInSeconds).toBeLessThanOrEqual(60);
        expect(data.url).toContain('expires=');
      }
    });

    it('rejects unauthenticated requests with 401 and private cache control', async () => {
      const { id } = await createHelperAchievementWithAssets('Auth Protection Test');

      const unauthReq = new NextRequest(`http://localhost:3000/api/achievements/${id}/assets`, {
        method: 'GET',
      });
      const unauthRes = await getAssetsHandler(unauthReq, { params: Promise.resolve({ id }) });
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.headers.get('cache-control')).toBe('private, no-store, no-cache, must-revalidate');
    });
  });
});
