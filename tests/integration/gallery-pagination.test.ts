import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resetDatabase, getDb } from '@/lib/db';
import { achievements } from '@/lib/db/schema';
import { GET as galleryHandler } from '@/app/api/achievements/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';

describe('Integration: Gallery Query Engine, Cursor Pagination & Search', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('paginates deterministically across 50 items with zero duplicates or skips', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const db = await getDb();

    // Insert 50 achievements across distinct dates
    const totalCount = 50;
    const insertedIds = new Set<string>();

    for (let i = 0; i < totalCount; i++) {
      const id = crypto.randomUUID();
      insertedIds.add(id);

      // Distribute dates: day decreases from 28 down to 1
      const day = String(28 - (i % 28)).padStart(2, '0');
      const month = String(1 + Math.floor(i / 28)).padStart(2, '0');
      const completionDate = `2026-${month}-${day}`;

      await db.insert(achievements).values({
        id,
        title: `Artwork #${i + 1}`,
        completionDate,
        notes: `Notes for piece ${i + 1}`,
        tags: [`tag${i % 5}`],
        state: 'ready',
      });
    }

    // Page 1: fetch first 24 items
    const req1 = new NextRequest('http://localhost:3000/api/achievements?limit=24', {
      method: 'GET',
      headers,
    });
    const res1 = await galleryHandler(req1);
    expect(res1.status).toBe(200);

    // Verify private cache headers
    expect(res1.headers.get('cache-control')).toBe('private, no-store, no-cache, must-revalidate');

    const page1 = (await res1.json()) as {
      items: Array<{ id: string; completionDate: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };

    expect(page1.items.length).toBe(24);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    // Page 2: fetch next 24 items with cursor
    const req2 = new NextRequest(
      `http://localhost:3000/api/achievements?limit=24&cursor=${page1.nextCursor}`,
      {
        method: 'GET',
        headers,
      }
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

    // Page 3: fetch remaining 2 items
    const req3 = new NextRequest(
      `http://localhost:3000/api/achievements?limit=24&cursor=${page2.nextCursor}`,
      {
        method: 'GET',
        headers,
      }
    );
    const res3 = await galleryHandler(req3);
    expect(res3.status).toBe(200);

    const page3 = (await res3.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };

    expect(page3.items.length).toBe(2);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();

    // Ensure strictly 0 duplicates and all 50 items were received
    const collectedIds = [
      ...page1.items.map((it) => it.id),
      ...page2.items.map((it) => it.id),
      ...page3.items.map((it) => it.id),
    ];

    expect(collectedIds.length).toBe(50);
    const uniqueCollected = new Set(collectedIds);
    expect(uniqueCollected.size).toBe(50);
    expect(uniqueCollected).toEqual(insertedIds);
  });

  it('handles boundary condition: exactly 24 items (no page 2 cursor)', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const db = await getDb();

    for (let i = 0; i < 24; i++) {
      await db.insert(achievements).values({
        id: crypto.randomUUID(),
        title: `Piece ${i + 1}`,
        completionDate: '2026-05-01',
        state: 'ready',
      });
    }

    const req = new NextRequest('http://localhost:3000/api/achievements?limit=24', {
      method: 'GET',
      headers,
    });
    const res = await galleryHandler(req);
    const data = (await res.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };

    expect(data.items.length).toBe(24);
    expect(data.hasMore).toBe(false);
    expect(data.nextCursor).toBeNull();
  });

  it('handles empty archive cleanly', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const req = new NextRequest('http://localhost:3000/api/achievements', {
      method: 'GET',
      headers,
    });
    const res = await galleryHandler(req);
    const data = (await res.json()) as {
      items: unknown[];
      nextCursor: string | null;
      hasMore: boolean;
    };

    expect(data.items).toEqual([]);
    expect(data.hasMore).toBe(false);
    expect(data.nextCursor).toBeNull();
  });

  it('filters results by title and tags with case-insensitivity', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const db = await getDb();

    await db.insert(achievements).values([
      {
        id: crypto.randomUUID(),
        title: 'Golden Sunset at the Beach',
        completionDate: '2026-06-01',
        tags: ['beach', 'oil'],
        state: 'ready',
      },
      {
        id: crypto.randomUUID(),
        title: 'Winter Mountain Snow',
        completionDate: '2026-06-02',
        tags: ['snow', 'acrylic'],
        state: 'ready',
      },
      {
        id: crypto.randomUUID(),
        title: 'Portrait in Charcoal',
        completionDate: '2026-06-03',
        tags: ['charcoal', 'portrait', 'beach'],
        state: 'ready',
      },
    ]);

    // Search by title substring: "sunset"
    const req1 = new NextRequest('http://localhost:3000/api/achievements?q=sunset', {
      method: 'GET',
      headers,
    });
    const res1 = await galleryHandler(req1);
    const data1 = (await res1.json()) as { items: Array<{ title: string }> };
    expect(data1.items.length).toBe(1);
    expect(data1.items[0]!.title).toBe('Golden Sunset at the Beach');

    // Search by tag: "beach" (matches 2 items)
    const req2 = new NextRequest('http://localhost:3000/api/achievements?q=beach', {
      method: 'GET',
      headers,
    });
    const res2 = await galleryHandler(req2);
    const data2 = (await res2.json()) as { items: Array<{ title: string }> };
    expect(data2.items.length).toBe(2);

    // Search matching nothing
    const req3 = new NextRequest('http://localhost:3000/api/achievements?q=nonexistent', {
      method: 'GET',
      headers,
    });
    const res3 = await galleryHandler(req3);
    const data3 = (await res3.json()) as { items: unknown[] };
    expect(data3.items.length).toBe(0);
  });

  it('strictly excludes pending or deleting achievements from the gallery', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const db = await getDb();

    await db.insert(achievements).values([
      {
        id: crypto.randomUUID(),
        title: 'Ready Artwork',
        completionDate: '2026-06-01',
        state: 'ready',
      },
      {
        id: crypto.randomUUID(),
        title: 'Pending Artwork',
        completionDate: '2026-06-02',
        state: 'pending',
      },
      {
        id: crypto.randomUUID(),
        title: 'Deleting Artwork',
        completionDate: '2026-06-03',
        state: 'deleting',
      },
    ]);

    const req = new NextRequest('http://localhost:3000/api/achievements', {
      method: 'GET',
      headers,
    });
    const res = await galleryHandler(req);
    const data = (await res.json()) as { items: Array<{ title: string }> };

    expect(data.items.length).toBe(1);
    expect(data.items[0]!.title).toBe('Ready Artwork');
  });
});
