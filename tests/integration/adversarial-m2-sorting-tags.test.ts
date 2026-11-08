import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resetDatabase, getDb } from '@/lib/db';
import { achievements } from '@/lib/db/schema';
import { GET as galleryHandler } from '@/app/api/achievements/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import {
  validateAchievementSort,
  validateTagFilter,
  ValidationError,
} from '@/lib/validation/achievement';

describe('Adversarial Stress Test: Milestone 2 Sorting, Exact Tags & Cursors', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  // =========================================================================
  // 1. MASSIVE DATE CLUSTER COLLISIONS IN ASCENDING SORT ORDER (sort=oldest)
  // =========================================================================
  describe('1. Massive Date Cluster Collisions in Ascending Sort Order', () => {
    it('paginates 50 items with identical completion dates across 5 pages with 0 duplicates, 0 skips, and 100% item recovery', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      const collisionDate = '2026-07-20';
      const inserted: Array<{ id: string; title: string; completionDate: string }> = [];

      for (let i = 0; i < 50; i++) {
        const id = crypto.randomUUID();
        const title = `Collision Artwork #${String(i + 1).padStart(2, '0')}`;
        inserted.push({ id, title, completionDate: collisionDate });

        await db.insert(achievements).values({
          id,
          title,
          completionDate: collisionDate,
          notes: `Collision stress note ${i}`,
          tags: ['date-collision-cluster'],
          state: 'ready',
        });
      }

      expect(inserted.length).toBe(50);

      // Deterministic Oracle for sort=oldest with identical completion dates:
      // Since completionDate is identical across all rows, the order is strictly determined by id ASC
      const groundTruthOrder = [...inserted].sort((a, b) => a.id.localeCompare(b.id));

      const collectedItems: Array<{ id: string; title: string; completionDate: string }> = [];
      let currentCursor: string | null = null;
      let pageCount = 0;

      // Page limit = 10, meaning 50 items must produce exactly 5 pages (10 items each)
      const limit = 10;

      while (true) {
        pageCount++;
        const cursorQuery = currentCursor ? `&cursor=${encodeURIComponent(currentCursor)}` : '';
        const req = new NextRequest(
          `http://localhost:3000/api/achievements?sort=oldest&limit=${limit}${cursorQuery}`,
          { method: 'GET', headers }
        );

        const res = await galleryHandler(req);
        expect(res.status).toBe(200);

        const body = (await res.json()) as {
          items: Array<{ id: string; title: string; completionDate: string }>;
          nextCursor: string | null;
          hasMore: boolean;
        };

        expect(body.items.length).toBe(limit);
        collectedItems.push(...body.items);

        // Verify cursor format: "<completionDate>_<UUID>"
        if (pageCount < 5) {
          expect(body.hasMore).toBe(true);
          expect(body.nextCursor).toBeTruthy();
          const expectedLast = body.items[body.items.length - 1]!;
          expect(body.nextCursor).toBe(`${expectedLast.completionDate}_${expectedLast.id}`);
          currentCursor = body.nextCursor;
        } else {
          // Page 5 is the final page
          expect(body.hasMore).toBe(false);
          expect(body.nextCursor).toBeNull();
          break;
        }

        // Safety break to prevent infinite loops in buggy pagination
        if (pageCount > 10) {
          throw new Error('Pagination exceeded expected page count — possible infinite loop');
        }
      }

      expect(pageCount).toBe(5);
      expect(collectedItems.length).toBe(50);

      // Verify ZERO DUPLICATES
      const collectedIds = collectedItems.map((it) => it.id);
      const uniqueCollectedIds = new Set(collectedIds);
      expect(uniqueCollectedIds.size).toBe(50);

      // Verify ZERO SKIPS and 100% ITEM RECOVERY
      const expectedIds = groundTruthOrder.map((it) => it.id);
      expect(collectedIds).toEqual(expectedIds);

      // Verify strict monotonic id ASC order on identical dates
      for (let i = 0; i < collectedItems.length - 1; i++) {
        const curr = collectedItems[i]!;
        const next = collectedItems[i + 1]!;
        expect(curr.completionDate).toBe(collisionDate);
        expect(next.completionDate).toBe(collisionDate);
        expect(curr.id.localeCompare(next.id)).toBeLessThan(0);
      }
    });

    it('paginates across multiple date cluster boundaries in ascending sort order without losing or repeating items', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // 4 clusters of 15 items each = 60 items total
      // Paginating with limit=12 creates page boundaries that bisect clusters:
      // Page 1: 12 from Cluster 1
      // Page 2: 3 from Cluster 1, 9 from Cluster 2
      // Page 3: 6 from Cluster 2, 6 from Cluster 3
      // Page 4: 9 from Cluster 3, 3 from Cluster 4
      // Page 5: 12 from Cluster 4
      const clusters = [
        { date: '2026-02-01', count: 15 },
        { date: '2026-02-02', count: 15 },
        { date: '2026-02-03', count: 15 },
        { date: '2026-02-04', count: 15 },
      ];

      const inserted: Array<{ id: string; completionDate: string }> = [];

      for (const cluster of clusters) {
        for (let i = 0; i < cluster.count; i++) {
          const id = crypto.randomUUID();
          inserted.push({ id, completionDate: cluster.date });

          await db.insert(achievements).values({
            id,
            title: `Boundary Artwork ${cluster.date} #${i + 1}`,
            completionDate: cluster.date,
            tags: ['boundary-cluster'],
            state: 'ready',
          });
        }
      }

      expect(inserted.length).toBe(60);

      // Ground truth oracle for ascending sort: completionDate ASC, then id ASC
      const groundTruthOrder = [...inserted].sort((a, b) => {
        if (a.completionDate !== b.completionDate) {
          return a.completionDate.localeCompare(b.completionDate);
        }
        return a.id.localeCompare(b.id);
      });

      const collected: Array<{ id: string; completionDate: string }> = [];
      let cursor: string | null = null;
      let pages = 0;

      while (true) {
        pages++;
        const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const req = new NextRequest(
          `http://localhost:3000/api/achievements?sort=oldest&limit=12${cursorQuery}`,
          { method: 'GET', headers }
        );
        const res = await galleryHandler(req);
        expect(res.status).toBe(200);

        const data = (await res.json()) as {
          items: Array<{ id: string; completionDate: string }>;
          nextCursor: string | null;
          hasMore: boolean;
        };

        expect(data.items.length).toBe(12);
        collected.push(...data.items);

        if (pages < 5) {
          expect(data.hasMore).toBe(true);
          expect(data.nextCursor).toBeTruthy();
          cursor = data.nextCursor;
        } else {
          expect(data.hasMore).toBe(false);
          expect(data.nextCursor).toBeNull();
          break;
        }

        if (pages > 10) throw new Error('Infinite loop detected in multi-cluster pagination');
      }

      expect(pages).toBe(5);
      expect(collected.length).toBe(60);

      // 0 duplicates, 0 skips, identical to ground truth oracle
      expect(new Set(collected.map((it) => it.id)).size).toBe(60);
      expect(collected.map((it) => it.id)).toEqual(groundTruthOrder.map((it) => it.id));
    });
  });

  // =========================================================================
  // 2. TAG MATCHING EDGE CASES
  // =========================================================================
  describe('2. Tag Matching Edge Cases', () => {
    it('strictly isolates exact tags from substrings, superstrings, and partial words', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      const itemExactArt = crypto.randomUUID();
      const itemArtist = crypto.randomUUID();
      const itemFineArt = crypto.randomUUID();
      const itemSmart = crypto.randomUUID();
      const itemArtMulti = crypto.randomUUID();

      await db.insert(achievements).values([
        {
          id: itemExactArt,
          title: 'Exact Art Single',
          completionDate: '2026-03-01',
          tags: ['art'],
          state: 'ready',
        },
        {
          id: itemArtist,
          title: 'Artist Portfolio',
          completionDate: '2026-03-02',
          tags: ['artist'],
          state: 'ready',
        },
        {
          id: itemFineArt,
          title: 'Fine Art Museum',
          completionDate: '2026-03-03',
          tags: ['fine-art'],
          state: 'ready',
        },
        {
          id: itemSmart,
          title: 'Smart Tech Design',
          completionDate: '2026-03-04',
          tags: ['smart'],
          state: 'ready',
        },
        {
          id: itemArtMulti,
          title: 'Multi Tag Art Piece',
          completionDate: '2026-03-05',
          tags: ['art', 'modern', 'canvas'],
          state: 'ready',
        },
      ]);

      // Query exact tag "art"
      const req = new NextRequest('http://localhost:3000/api/achievements?tag=art', {
        method: 'GET',
        headers,
      });
      const res = await galleryHandler(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as { items: Array<{ id: string }> };
      const matchedIds = data.items.map((it) => it.id);

      // MUST match exactly itemExactArt and itemArtMulti
      expect(matchedIds.length).toBe(2);
      expect(matchedIds).toContain(itemExactArt);
      expect(matchedIds).toContain(itemArtMulti);

      // MUST NOT match substring or superstring variants
      expect(matchedIds).not.toContain(itemArtist);
      expect(matchedIds).not.toContain(itemFineArt);
      expect(matchedIds).not.toContain(itemSmart);
    });

    it('matches non-alphanumeric, special character, and unicode tags accurately', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      const specialTagFixtures = [
        { tag: 'c++', title: 'C++ Code Visualizer' },
        { tag: 'pixel_art', title: 'Pixel Art Canvas' },
        { tag: 'v2.0', title: 'Release Version 2.0 Art' },
        { tag: '@artist', title: 'Artist Handle Concept' },
        { tag: '#featured', title: 'Hashtag Featured Work' },
        { tag: 'sci-fi', title: 'Science Fiction Scene' },
        { tag: '3d:render', title: '3D Render Composite' },
        { tag: 'concept art', title: 'Concept Art Matte' },
        { tag: '🎨art', title: 'Palette Emoji Art' },
        { tag: '水墨画', title: 'Sumi-e Ink Painting' },
      ];

      const insertedMap = new Map<string, string>();

      for (const fix of specialTagFixtures) {
        const id = crypto.randomUUID();
        insertedMap.set(fix.tag, id);

        await db.insert(achievements).values({
          id,
          title: fix.title,
          completionDate: '2026-04-10',
          tags: [fix.tag],
          state: 'ready',
        });
      }

      // Probe each special tag individually
      for (const fix of specialTagFixtures) {
        const req = new NextRequest(
          `http://localhost:3000/api/achievements?tag=${encodeURIComponent(fix.tag)}`,
          { method: 'GET', headers }
        );
        const res = await galleryHandler(req);
        expect(res.status).toBe(200);

        const data = (await res.json()) as { items: Array<{ id: string; tags: string[] }> };
        expect(data.items.length).toBe(1);
        expect(data.items[0]!.id).toBe(insertedMap.get(fix.tag));
        expect(data.items[0]!.tags).toContain(fix.tag);
      }
    });

    it('normalizes uppercase tags and trims whitespace', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      const itemId = crypto.randomUUID();
      await db.insert(achievements).values({
        id: itemId,
        title: 'Impressionist Sunflowers',
        completionDate: '2026-05-15',
        tags: ['impressionism'],
        state: 'ready',
      });

      // Upper case and padded queries
      const queryVariations = ['IMPRESSIONISM', 'Impressionism', '  impressionism  ', '  IMPRESSIONISM  '];

      for (const qTag of queryVariations) {
        const req = new NextRequest(
          `http://localhost:3000/api/achievements?tag=${encodeURIComponent(qTag)}`,
          { method: 'GET', headers }
        );
        const res = await galleryHandler(req);
        expect(res.status).toBe(200);

        const data = (await res.json()) as { items: Array<{ id: string }> };
        expect(data.items.length).toBe(1);
        expect(data.items[0]!.id).toBe(itemId);
      }
    });

    it('clears tag filter and restores full collection on empty string or whitespace tag', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      for (let i = 0; i < 5; i++) {
        await db.insert(achievements).values({
          id: crypto.randomUUID(),
          title: `Art Piece ${i + 1}`,
          completionDate: `2026-05-0${i + 1}`,
          tags: [`tag-${i}`],
          state: 'ready',
        });
      }

      // Queries with empty string or whitespace
      for (const emptyTag of ['', '   ', '\t']) {
        const req = new NextRequest(
          `http://localhost:3000/api/achievements?tag=${encodeURIComponent(emptyTag)}`,
          { method: 'GET', headers }
        );
        const res = await galleryHandler(req);
        expect(res.status).toBe(200);

        const data = (await res.json()) as { items: Array<{ id: string }> };
        expect(data.items.length).toBe(5);
      }
    });

    it('enforces maximum 24 character tag length boundary at validation', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // Exactly 24 characters: valid
      const valid24 = 'a'.repeat(24);
      const reqValid = new NextRequest(
        `http://localhost:3000/api/achievements?tag=${valid24}`,
        { method: 'GET', headers }
      );
      const resValid = await galleryHandler(reqValid);
      expect(resValid.status).toBe(200);

      // 25 characters: invalid -> HTTP 400 INVALID_TAGS
      const invalid25 = 'a'.repeat(25);
      const reqInvalid = new NextRequest(
        `http://localhost:3000/api/achievements?tag=${invalid25}`,
        { method: 'GET', headers }
      );
      const resInvalid = await galleryHandler(reqInvalid);
      expect(resInvalid.status).toBe(400);

      const errorBody = (await resInvalid.json()) as { code: string; error: string };
      expect(errorBody.code).toBe('INVALID_TAGS');
      expect(errorBody.error).toContain('exceeds the maximum length of 24 characters');
    });

    it('safely neutralizes JSONB and SQL injection attempts in tag parameter', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      await db.insert(achievements).values({
        id: crypto.randomUUID(),
        title: 'Benign Art Piece',
        completionDate: '2026-05-01',
        tags: ['benign'],
        state: 'ready',
      });

      const maliciousTags = [
        '["benign"]',
        '{"$gt": ""}',
        "' OR '1'='1",
        '\\"; DROP TABLE achievements; --',
        '\\u0000',
        '\' UNION SELECT 1--',
      ];

      for (const badTag of maliciousTags) {
        // Tag must be <= 24 characters to pass length validation and reach JSONB query
        const trimmedTag = badTag.slice(0, 24);
        const req = new NextRequest(
          `http://localhost:3000/api/achievements?tag=${encodeURIComponent(trimmedTag)}`,
          { method: 'GET', headers }
        );
        const res = await galleryHandler(req);
        // Parameterized query must succeed without SQL syntax or JSON parsing crash
        expect(res.status).toBe(200);

        const data = (await res.json()) as { items: Array<{ id: string }> };
        expect(data.items.length).toBe(0);
      }

      // Verify database integrity: achievements table is intact
      const rows = await db.select().from(achievements);
      expect(rows.length).toBe(1);
    });
  });

  // =========================================================================
  // 3. INVALID SORT REJECTION & PARAMETER INJECTIONS
  // =========================================================================
  describe('3. Invalid Sort Rejection and Parameter Injections', () => {
    it('strictly rejects unauthorized sort directions and keywords with HTTP 400 INVALID_SORT', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const invalidSorts = [
        'ascending',
        'descending',
        'asc',
        'desc',
        'random',
        'created_at',
        'title',
        'completion_date',
        'none',
        '1',
        '0',
        'true',
        'false',
        'null',
        'undefined',
      ];

      for (const invalid of invalidSorts) {
        const req = new NextRequest(
          `http://localhost:3000/api/achievements?sort=${invalid}`,
          { method: 'GET', headers }
        );
        const res = await galleryHandler(req);
        expect(res.status).toBe(400);

        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('INVALID_SORT');
        expect(body.error).toBe('Sort must be either "newest" or "oldest".');
      }
    });

    it('rejects SQL injection attacks and prototype pollution attempts in sort parameter', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      await db.insert(achievements).values({
        id: crypto.randomUUID(),
        title: 'Safety Check Piece',
        completionDate: '2026-06-01',
        tags: ['safety'],
        state: 'ready',
      });

      const hostileSortPayloads = [
        "' OR '1'='1",
        "oldest; DROP TABLE achievements; --",
        "newest' UNION SELECT 1, 2, 3 --",
        "oldest' OR 1=1 --",
        "__proto__",
        "constructor",
        "prototype",
        "newest%00",
        "oldest\0",
        "oldest/**/and/**/1=1",
      ];

      for (const payload of hostileSortPayloads) {
        const req = new NextRequest(
          `http://localhost:3000/api/achievements?sort=${encodeURIComponent(payload)}`,
          { method: 'GET', headers }
        );
        const res = await galleryHandler(req);
        expect(res.status).toBe(400);

        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('INVALID_SORT');
      }

      // Verify database table was not affected
      const rows = await db.select().from(achievements);
      expect(rows.length).toBe(1);
    });

    it('unit: validateAchievementSort rejects non-string types and malformed inputs', () => {
      expect(validateAchievementSort(undefined)).toBe('newest');
      expect(validateAchievementSort(null)).toBe('newest');
      expect(validateAchievementSort('')).toBe('newest');
      expect(validateAchievementSort('newest')).toBe('newest');
      expect(validateAchievementSort('oldest')).toBe('oldest');
      expect(validateAchievementSort('NEWEST')).toBe('newest');
      expect(validateAchievementSort('OLDEST')).toBe('oldest');
      expect(validateAchievementSort('  oldest  ')).toBe('oldest');

      // Whitespace-only string is not empty string, and trims to non-sort value -> throws
      expect(() => validateAchievementSort('   ')).toThrow(ValidationError);
      expect(() => validateAchievementSort(123)).toThrow(ValidationError);
      expect(() => validateAchievementSort(true)).toThrow(ValidationError);
      expect(() => validateAchievementSort({})).toThrow(ValidationError);
      expect(() => validateAchievementSort(['newest'])).toThrow(ValidationError);
      expect(() => validateAchievementSort('asc')).toThrow(ValidationError);
      expect(() => validateAchievementSort('desc')).toThrow(ValidationError);
    });

    it('unit: validateTagFilter validates strings and normalizes correctly', () => {
      expect(validateTagFilter(undefined)).toBe('');
      expect(validateTagFilter(null)).toBe('');
      expect(validateTagFilter('')).toBe('');
      expect(validateTagFilter('   ')).toBe('');
      expect(validateTagFilter('ART')).toBe('art');
      expect(validateTagFilter('  Oil-Painting  ')).toBe('oil-painting');

      expect(() => validateTagFilter(123)).toThrow(ValidationError);
      expect(() => validateTagFilter({})).toThrow(ValidationError);
      expect(() => validateTagFilter('a'.repeat(25))).toThrow(ValidationError);
    });
  });

  // =========================================================================
  // 4. CURSOR TAMPERING & CROSS-SORT RESILIENCE
  // =========================================================================
  describe('4. Cursor Tampering & Cross-Sort Resilience', () => {
    it('handles malformed cursor formats gracefully without server crash', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      await db.insert(achievements).values({
        id: crypto.randomUUID(),
        title: 'Cursor Test Piece',
        completionDate: '2026-06-01',
        tags: ['cursor-test'],
        state: 'ready',
      });

      // 1. Missing separator (no underscore) -> ignored, returns page 1
      const reqNoSep = new NextRequest(
        'http://localhost:3000/api/achievements?cursor=2026-06-01-no-underscore',
        { method: 'GET', headers }
      );
      const resNoSep = await galleryHandler(reqNoSep);
      expect(resNoSep.status).toBe(200);
      const dataNoSep = (await resNoSep.json()) as { items: Array<{ id: string }> };
      expect(dataNoSep.items.length).toBe(1);

      // 2. Leading underscore (_UUID without date) -> ignored, returns page 1
      const reqLeadSep = new NextRequest(
        `http://localhost:3000/api/achievements?cursor=_${crypto.randomUUID()}`,
        { method: 'GET', headers }
      );
      const resLeadSep = await galleryHandler(reqLeadSep);
      expect(resLeadSep.status).toBe(200);

      // 3. Trailing underscore (date with empty cursorId) -> cursorId is empty string, falsy check ignores cursor and safely returns page 1 (200 OK)
      const reqTrailSep = new NextRequest(
        'http://localhost:3000/api/achievements?cursor=2026-06-01_',
        { method: 'GET', headers }
      );
      const resTrailSep = await galleryHandler(reqTrailSep);
      expect(resTrailSep.status).toBe(200);
      const dataTrailSep = (await resTrailSep.json()) as { items: Array<{ id: string }> };
      expect(dataTrailSep.items.length).toBe(1);

      // 4. Invalid UUID in cursor id -> safe error response (500 DATABASE_ERROR)
      const reqBadUuid = new NextRequest(
        'http://localhost:3000/api/achievements?cursor=2026-06-01_not-a-valid-uuid',
        { method: 'GET', headers }
      );
      const resBadUuid = await galleryHandler(reqBadUuid);
      expect(resBadUuid.status).toBe(500);
    });

    it('handles cross-sort cursor handoff gracefully without crashing or looping', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // Insert 10 items
      for (let i = 0; i < 10; i++) {
        await db.insert(achievements).values({
          id: crypto.randomUUID(),
          title: `Piece ${i + 1}`,
          completionDate: `2026-06-${String(i + 1).padStart(2, '0')}`,
          tags: ['cross-sort'],
          state: 'ready',
        });
      }

      // Step 1: Obtain a cursor from descending sort (sort=newest)
      const reqNewest = new NextRequest(
        'http://localhost:3000/api/achievements?sort=newest&limit=3',
        { method: 'GET', headers }
      );
      const resNewest = await galleryHandler(reqNewest);
      const dataNewest = (await resNewest.json()) as { nextCursor: string };
      expect(dataNewest.nextCursor).toBeTruthy();

      // Step 2: Pass that descending cursor to ascending sort (sort=oldest)
      const reqOldestWithDescCursor = new NextRequest(
        `http://localhost:3000/api/achievements?sort=oldest&limit=3&cursor=${dataNewest.nextCursor}`,
        { method: 'GET', headers }
      );
      const resOldest = await galleryHandler(reqOldestWithDescCursor);
      // Evaluates as valid SQL condition: completionDate > cursorDate OR (eq and id > cursorId)
      expect(resOldest.status).toBe(200);

      const dataOldest = (await resOldest.json()) as { items: Array<{ completionDate: string }> };
      // All items returned must have completionDate >= cursorDate
      const [cursorDate] = dataNewest.nextCursor.split('_');
      for (const item of dataOldest.items) {
        expect(item.completionDate >= cursorDate!).toBe(true);
      }
    });
  });

  // =========================================================================
  // 5. COMBINED ADVERSARIAL FILTER & ASCENDING SORT STRESS
  // =========================================================================
  describe('5. Combined Adversarial Filters & Ascending Sort Stress', () => {
    it('composes exact tag filter, date range, search query, and ascending sort order correctly', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      const itemTargetOld = crypto.randomUUID();
      const itemTargetMid = crypto.randomUUID();
      const itemTargetNew = crypto.randomUUID();
      const itemWrongTag = crypto.randomUUID();
      const itemOutsideDate = crypto.randomUUID();
      const itemWrongTitle = crypto.randomUUID();

      await db.insert(achievements).values([
        {
          id: itemTargetOld,
          title: 'Masterpiece Sunset Landscape #1',
          completionDate: '2026-05-10',
          tags: ['oil', 'featured'],
          notes: 'Golden hour lighting',
          state: 'ready',
        },
        {
          id: itemTargetMid,
          title: 'Masterpiece Sunset Landscape #2',
          completionDate: '2026-05-15',
          tags: ['oil', 'landscape'],
          notes: 'Oil canvas study',
          state: 'ready',
        },
        {
          id: itemTargetNew,
          title: 'Masterpiece Sunset Landscape #3',
          completionDate: '2026-05-20',
          tags: ['oil', 'featured'],
          notes: 'Final gallery piece',
          state: 'ready',
        },
        {
          id: itemWrongTag,
          title: 'Masterpiece Sunset Landscape #4',
          completionDate: '2026-05-12',
          tags: ['watercolor'], // Lacks exact tag 'oil'
          notes: 'Watercolor version',
          state: 'ready',
        },
        {
          id: itemOutsideDate,
          title: 'Masterpiece Sunset Landscape #5',
          completionDate: '2026-06-01', // Outside date range [2026-05-01, 2026-05-25]
          tags: ['oil'],
          notes: 'Late painting',
          state: 'ready',
        },
        {
          id: itemWrongTitle,
          title: 'Abstract Geometric Cubism', // Does not match q="sunset"
          completionDate: '2026-05-14',
          tags: ['oil'],
          notes: 'Geometric structure in monochrome',
          state: 'ready',
        },
      ]);

      const req = new NextRequest(
        'http://localhost:3000/api/achievements?q=Sunset&tag=oil&from=2026-05-01&to=2026-05-25&sort=oldest',
        { method: 'GET', headers }
      );
      const res = await galleryHandler(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as {
        items: Array<{ id: string; title: string; completionDate: string }>;
      };

      // Only the 3 target items match all criteria
      expect(data.items.length).toBe(3);
      // Strictly in oldest first order: May 10, May 15, May 20
      expect(data.items.map((it) => it.id)).toEqual([itemTargetOld, itemTargetMid, itemTargetNew]);
      expect(data.items.map((it) => it.completionDate)).toEqual([
        '2026-05-10',
        '2026-05-15',
        '2026-05-20',
      ]);
    });
  });
});
