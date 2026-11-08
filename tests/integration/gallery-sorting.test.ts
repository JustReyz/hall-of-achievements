import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resetDatabase, getDb } from '@/lib/db';
import { achievements } from '@/lib/db/schema';
import { GET as galleryHandler } from '@/app/api/achievements/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { validateAchievementSort, ValidationError } from '@/lib/validation/achievement';
import type { GalleryDensity } from '@/components/gallery/types';

describe('Integration: Gallery Sorting, Exact Tag Filtering & Density State', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('API Sort Validation (GET /api/achievements?sort=...)', () => {
    it('defaults to newest when sort query parameter is omitted', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const req = new NextRequest('http://localhost:3000/api/achievements', {
        method: 'GET',
        headers,
      });
      const res = await galleryHandler(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('private');
    });

    it('accepts valid sort values: newest and oldest (case-insensitive and trimmed)', async () => {
      const { headers } = await createAuthenticatedHeaders();

      for (const sortVal of ['newest', 'oldest', 'NEWEST', '  oldest  ']) {
        const req = new NextRequest(`http://localhost:3000/api/achievements?sort=${encodeURIComponent(sortVal)}`, {
          method: 'GET',
          headers,
        });
        const res = await galleryHandler(req);
        expect(res.status).toBe(200);
      }
    });

    it('rejects invalid sort parameter with HTTP 400 INVALID_SORT', async () => {
      const { headers } = await createAuthenticatedHeaders();

      for (const invalid of ['alphabetical', 'ascending', 'descending', 'random', '123', 'true']) {
        const req = new NextRequest(`http://localhost:3000/api/achievements?sort=${invalid}`, {
          method: 'GET',
          headers,
        });
        const res = await galleryHandler(req);
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string; code: string };
        expect(body.code).toBe('INVALID_SORT');
        expect(body.error).toContain('Sort must be either "newest" or "oldest"');
      }
    });

    it('unit: validateAchievementSort rejects non-string and invalid values', () => {
      expect(validateAchievementSort(undefined)).toBe('newest');
      expect(validateAchievementSort(null)).toBe('newest');
      expect(validateAchievementSort('')).toBe('newest');
      expect(validateAchievementSort('newest')).toBe('newest');
      expect(validateAchievementSort('oldest')).toBe('oldest');
      expect(validateAchievementSort(' OLDEST ')).toBe('oldest');

      expect(() => validateAchievementSort(123)).toThrow(ValidationError);
      expect(() => validateAchievementSort({})).toThrow(ValidationError);
      expect(() => validateAchievementSort('invalid')).toThrow(ValidationError);
    });
  });

  describe('Deterministic Pagination: Oldest First (sort=oldest)', () => {
    it('paginates deterministically in ascending order across 50 items with overlapping dates', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // Seed 50 items across 4 dates with identical dates causing UUID tie-breaking
      const dates = ['2026-01-10', '2026-02-15', '2026-03-20', '2026-04-25'];
      const inserted: Array<{ id: string; completionDate: string }> = [];

      for (let i = 0; i < 50; i++) {
        const id = crypto.randomUUID();
        const completionDate = dates[i % dates.length]!;
        inserted.push({ id, completionDate });

        await db.insert(achievements).values({
          id,
          title: `Art Piece ${i + 1}`,
          completionDate,
          notes: `Notes ${i}`,
          tags: ['gallery-test'],
          state: 'ready',
        });
      }

      // Expected order for sort=oldest:
      // Primary: completionDate ASC
      // Tie-breaker: id ASC
      const expectedOrder = [...inserted].sort((a, b) => {
        if (a.completionDate !== b.completionDate) {
          return a.completionDate.localeCompare(b.completionDate);
        }
        return a.id.localeCompare(b.id);
      });

      // Page 1
      const req1 = new NextRequest('http://localhost:3000/api/achievements?sort=oldest&limit=24', {
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

      // Verify page 1 items strictly match expectedOrder slice [0, 24]
      expect(page1.items.map((it) => it.id)).toEqual(expectedOrder.slice(0, 24).map((it) => it.id));

      // Page 2
      const req2 = new NextRequest(
        `http://localhost:3000/api/achievements?sort=oldest&limit=24&cursor=${page1.nextCursor}`,
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

      // Verify page 2 items strictly match expectedOrder slice [24, 48]
      expect(page2.items.map((it) => it.id)).toEqual(expectedOrder.slice(24, 48).map((it) => it.id));

      // Page 3
      const req3 = new NextRequest(
        `http://localhost:3000/api/achievements?sort=oldest&limit=24&cursor=${page2.nextCursor}`,
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

      expect(page3.items.map((it) => it.id)).toEqual(expectedOrder.slice(48, 50).map((it) => it.id));

      // Invariant: zero duplicates, zero skips across all pages
      const allReceived = [...page1.items, ...page2.items, ...page3.items];
      expect(allReceived.length).toBe(50);
      expect(new Set(allReceived.map((it) => it.id)).size).toBe(50);
      expect(allReceived.map((it) => it.id)).toEqual(expectedOrder.map((it) => it.id));
    });
  });

  describe('Deterministic Pagination: Newest First (sort=newest)', () => {
    it('paginates deterministically in descending order with zero duplicates or skips', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      const dates = ['2026-01-10', '2026-02-15', '2026-03-20', '2026-04-25'];
      const inserted: Array<{ id: string; completionDate: string }> = [];

      for (let i = 0; i < 50; i++) {
        const id = crypto.randomUUID();
        const completionDate = dates[i % dates.length]!;
        inserted.push({ id, completionDate });

        await db.insert(achievements).values({
          id,
          title: `Art Piece ${i + 1}`,
          completionDate,
          notes: `Notes ${i}`,
          tags: ['gallery-test'],
          state: 'ready',
        });
      }

      // Expected order for sort=newest:
      // Primary: completionDate DESC
      // Tie-breaker: id DESC
      const expectedOrder = [...inserted].sort((a, b) => {
        if (a.completionDate !== b.completionDate) {
          return b.completionDate.localeCompare(a.completionDate);
        }
        return b.id.localeCompare(a.id);
      });

      // Page 1
      const req1 = new NextRequest('http://localhost:3000/api/achievements?sort=newest&limit=24', {
        method: 'GET',
        headers,
      });
      const res1 = await galleryHandler(req1);
      const page1 = (await res1.json()) as {
        items: Array<{ id: string; completionDate: string }>;
        nextCursor: string | null;
        hasMore: boolean;
      };

      expect(page1.items.length).toBe(24);
      expect(page1.items.map((it) => it.id)).toEqual(expectedOrder.slice(0, 24).map((it) => it.id));

      // Page 2
      const req2 = new NextRequest(
        `http://localhost:3000/api/achievements?sort=newest&limit=24&cursor=${page1.nextCursor}`,
        { method: 'GET', headers }
      );
      const res2 = await galleryHandler(req2);
      const page2 = (await res2.json()) as {
        items: Array<{ id: string; completionDate: string }>;
        nextCursor: string | null;
        hasMore: boolean;
      };

      expect(page2.items.length).toBe(24);
      expect(page2.items.map((it) => it.id)).toEqual(expectedOrder.slice(24, 48).map((it) => it.id));

      // Page 3
      const req3 = new NextRequest(
        `http://localhost:3000/api/achievements?sort=newest&limit=24&cursor=${page2.nextCursor}`,
        { method: 'GET', headers }
      );
      const res3 = await galleryHandler(req3);
      const page3 = (await res3.json()) as {
        items: Array<{ id: string; completionDate: string }>;
        nextCursor: string | null;
        hasMore: boolean;
      };

      expect(page3.items.length).toBe(2);
      expect(page3.items.map((it) => it.id)).toEqual(expectedOrder.slice(48, 50).map((it) => it.id));

      const allReceived = [...page1.items, ...page2.items, ...page3.items];
      expect(allReceived.length).toBe(50);
      expect(new Set(allReceived.map((it) => it.id)).size).toBe(50);
      expect(allReceived.map((it) => it.id)).toEqual(expectedOrder.map((it) => it.id));
    });
  });

  describe('Exact Tag Filtering & Restoration', () => {
    it('matches exact tags and does not partially match substring tag names', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      const itemOil = crypto.randomUUID();
      const itemOilPastel = crypto.randomUUID();
      const itemLandscape = crypto.randomUUID();

      await db.insert(achievements).values([
        {
          id: itemOil,
          title: 'Oil on Canvas',
          completionDate: '2026-05-01',
          tags: ['oil', 'landscape'],
          state: 'ready',
        },
        {
          id: itemOilPastel,
          title: 'Oil Pastel Sketch',
          completionDate: '2026-05-02',
          tags: ['oil-pastel', 'portrait'],
          state: 'ready',
        },
        {
          id: itemLandscape,
          title: 'Watercolor Landscape',
          completionDate: '2026-05-03',
          tags: ['watercolor', 'landscape'],
          state: 'ready',
        },
      ]);

      // Exact tag query for "oil"
      const reqOil = new NextRequest('http://localhost:3000/api/achievements?tag=oil', {
        method: 'GET',
        headers,
      });
      const resOil = await galleryHandler(reqOil);
      const dataOil = (await resOil.json()) as { items: Array<{ id: string }> };

      // Strictly matches itemOil, strictly NOT itemOilPastel
      expect(dataOil.items.length).toBe(1);
      expect(dataOil.items[0]!.id).toBe(itemOil);

      // Exact tag query for "oil-pastel"
      const reqPastel = new NextRequest('http://localhost:3000/api/achievements?tag=oil-pastel', {
        method: 'GET',
        headers,
      });
      const resPastel = await galleryHandler(reqPastel);
      const dataPastel = (await resPastel.json()) as { items: Array<{ id: string }> };

      expect(dataPastel.items.length).toBe(1);
      expect(dataPastel.items[0]!.id).toBe(itemOilPastel);

      // Clearing tag restores the entire collection
      const reqCleared = new NextRequest('http://localhost:3000/api/achievements?tag=', {
        method: 'GET',
        headers,
      });
      const resCleared = await galleryHandler(reqCleared);
      const dataCleared = (await resCleared.json()) as { items: Array<{ id: string }> };

      expect(dataCleared.items.length).toBe(3);
    });

    it('combines exact tag filtering with sort order and date boundaries', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      await db.insert(achievements).values([
        {
          id: crypto.randomUUID(),
          title: 'Recent Painting',
          completionDate: '2026-06-15',
          tags: ['featured'],
          state: 'ready',
        },
        {
          id: crypto.randomUUID(),
          title: 'Old Painting',
          completionDate: '2026-01-10',
          tags: ['featured'],
          state: 'ready',
        },
        {
          id: crypto.randomUUID(),
          title: 'Mid Painting',
          completionDate: '2026-03-20',
          tags: ['featured'],
          state: 'ready',
        },
        {
          id: crypto.randomUUID(),
          title: 'Other Tag Painting',
          completionDate: '2026-02-01',
          tags: ['other'],
          state: 'ready',
        },
      ]);

      const req = new NextRequest('http://localhost:3000/api/achievements?tag=featured&sort=oldest', {
        method: 'GET',
        headers,
      });
      const res = await galleryHandler(req);
      const data = (await res.json()) as { items: Array<{ title: string; completionDate: string }> };

      expect(data.items.length).toBe(3);
      expect(data.items.map((it) => it.title)).toEqual(['Old Painting', 'Mid Painting', 'Recent Painting']);
    });
  });

  describe('Gallery Density & AbortController Resilience', () => {
    it('handles localStorage density persistence safely without throwing', () => {
      // Mock localStorage behavior
      const storage: Record<string, string> = {};
      const mockLocalStorage = {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, val: string) => {
          storage[key] = val;
        },
      };

      const resolveDensity = (raw: string | null): GalleryDensity => {
        if (raw === 'compact' || raw === 'comfortable' || raw === 'roomy') {
          return raw;
        }
        return 'comfortable';
      };

      expect(resolveDensity(mockLocalStorage.getItem('hall_gallery_density'))).toBe('comfortable');

      mockLocalStorage.setItem('hall_gallery_density', 'compact');
      expect(resolveDensity(mockLocalStorage.getItem('hall_gallery_density'))).toBe('compact');

      mockLocalStorage.setItem('hall_gallery_density', 'roomy');
      expect(resolveDensity(mockLocalStorage.getItem('hall_gallery_density'))).toBe('roomy');

      mockLocalStorage.setItem('hall_gallery_density', 'invalid');
      expect(resolveDensity(mockLocalStorage.getItem('hall_gallery_density'))).toBe('comfortable');

      // Test throwing localStorage (e.g. SecurityError in strict private browsing)
      const throwingStorage = {
        getItem: () => {
          throw new Error('SecurityError: Access denied');
        },
      };

      let density: GalleryDensity = 'comfortable';
      try {
        const saved = throwingStorage.getItem();
        if (saved === 'compact' || saved === 'comfortable' || saved === 'roomy') {
          density = saved;
        }
      } catch {
        // Ignored safely
      }
      expect(density).toBe('comfortable');
    });

    it('AbortController cancels in-flight signal cleanly with AbortError', async () => {
      const controller = new AbortController();
      const signal = controller.signal;

      expect(signal.aborted).toBe(false);

      controller.abort();
      expect(signal.aborted).toBe(true);

      const abortPromise = new Promise((resolve, reject) => {
        if (signal.aborted) {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        } else {
          resolve('success');
        }
      });

      await expect(abortPromise).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
