import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resetDatabase, getDb } from '@/lib/db';
import { achievements } from '@/lib/db/schema';
import { GET as galleryHandler } from '@/app/api/achievements/route';
import { GET as tagsHandler } from '@/app/api/tags/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';

interface GalleryItem {
  id: string;
  title: string;
  tags: string[];
  completionDate: string;
}

interface GalleryPayload {
  items: GalleryItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

async function insertAchievement(input: {
  title: string;
  completionDate: string;
  tags?: string[];
  notes?: string;
  state?: 'pending' | 'ready' | 'deleting';
}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.insert(achievements).values({
    id,
    title: input.title,
    completionDate: input.completionDate,
    notes: input.notes ?? '',
    tags: input.tags ?? [],
    state: input.state ?? 'ready',
  });
  return id;
}

async function requestGallery(query: string, headers: Record<string, string>) {
  const response = await galleryHandler(
    new NextRequest(`http://localhost:3000/api/achievements?${query}`, {
      method: 'GET',
      headers,
    })
  );
  return { response, payload: (await response.json()) as GalleryPayload };
}

async function requestTags(query: string, headers: Record<string, string>) {
  const response = await tagsHandler(
    new NextRequest(`http://localhost:3000/api/tags${query ? `?${query}` : ''}`, {
      method: 'GET',
      headers,
    })
  );
  return { response, payload: (await response.json()) as { tags: string[] } };
}

describe('Integration: Exact tag browsing', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('filters by exact array membership and normalizes the selected tag', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const oilId = await insertAchievement({
      title: 'Harbor at Dusk',
      completionDate: '2026-06-03',
      tags: ['oil', 'landscape'],
    });
    const oilPastelId = await insertAchievement({
      title: 'Soft Morning',
      completionDate: '2026-06-02',
      tags: ['oil-pastel'],
    });
    const titleOnlyId = await insertAchievement({
      title: 'Oil study notes',
      completionDate: '2026-06-01',
      tags: ['sketch'],
    });
    const notesOnlyId = await insertAchievement({
      title: 'Color notes',
      completionDate: '2026-05-31',
      tags: ['study'],
      notes: 'Oil on linen',
    });

    const exact = await requestGallery('tag=OIL', headers);
    expect(exact.response.status).toBe(200);
    expect(exact.payload.items.map((item) => item.id)).toEqual([oilId]);

    const pastel = await requestGallery('tag=oil-pastel', headers);
    expect(pastel.payload.items.map((item) => item.id)).toEqual([oilPastelId]);

    const search = await requestGallery('q=oil', headers);
    expect(new Set(search.payload.items.map((item) => item.id))).toEqual(
      new Set([oilId, oilPastelId, titleOnlyId, notesOnlyId])
    );

    const tags = await requestTags('tag=oil', headers);
    expect(tags.response.status).toBe(200);
    expect(tags.payload.tags).toEqual(['landscape', 'oil', 'oil-pastel', 'sketch', 'study']);
  });

  it('intersects exact tag, search, and date filters', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const matchId = await insertAchievement({
      title: 'Autumn Study',
      completionDate: '2026-06-10',
      tags: ['oil'],
      notes: 'Warm palette',
    });
    await insertAchievement({
      title: 'Autumn Study',
      completionDate: '2026-07-10',
      tags: ['oil'],
      notes: 'Warm palette',
    });
    await insertAchievement({
      title: 'Winter Study',
      completionDate: '2026-06-10',
      tags: ['oil'],
      notes: 'Warm palette',
    });
    await insertAchievement({
      title: 'Autumn Study',
      completionDate: '2026-06-10',
      tags: ['oil-pastel'],
      notes: 'Warm palette',
    });
    await insertAchievement({
      title: 'Autumn Study',
      completionDate: '2026-06-10',
      tags: ['mixed'],
      notes: 'Warm palette',
    });

    const { response, payload } = await requestGallery(
      'tag=oil&q=autumn&from=2026-06-01&to=2026-06-30',
      headers
    );
    expect(response.status).toBe(200);
    expect(payload.items.map((item) => item.id)).toEqual([matchId]);
  });

  it('lists sorted distinct tags across every matching page', async () => {
    const { headers } = await createAuthenticatedHeaders();

    for (let index = 0; index < 30; index++) {
      const day = String(index + 1).padStart(2, '0');
      await insertAchievement({
        title: `Painting ${index + 1}`,
        completionDate: `2026-06-${day}`,
        tags: index === 0 ? ['shared', 'tag-1', 'archival'] : ['shared', `tag-${index + 1}`],
      });
    }

    await insertAchievement({
      title: 'Sculpture Study',
      completionDate: '2026-06-15',
      tags: ['sculpture'],
    });
    await insertAchievement({
      title: 'Painting Outside Range',
      completionDate: '2026-05-15',
      tags: ['old'],
    });

    const firstPage = await requestGallery(
      'q=Painting&from=2026-06-01&to=2026-06-30&limit=24',
      headers
    );
    expect(firstPage.payload.items).toHaveLength(24);
    expect(firstPage.payload.hasMore).toBe(true);
    expect(
      firstPage.payload.items.some((item) => item.tags.includes('archival'))
    ).toBe(false);

    const { response, payload } = await requestTags(
      'q=Painting&from=2026-06-01&to=2026-06-30',
      headers
    );
    expect(response.status).toBe(200);

    const expected = [
      'archival',
      'shared',
      ...Array.from({ length: 30 }, (_, index) => `tag-${index + 1}`),
    ].sort();
    expect(payload.tags).toEqual(expected);
    expect(new Set(payload.tags).size).toBe(payload.tags.length);
    expect(payload.tags).not.toContain('sculpture');
    expect(payload.tags).not.toContain('old');
  });

  it('excludes pending and deleting records from the tag facet', async () => {
    const { headers } = await createAuthenticatedHeaders();
    await insertAchievement({
      title: 'Ready Work',
      completionDate: '2026-06-01',
      tags: ['ready-tag'],
    });
    await insertAchievement({
      title: 'Pending Work',
      completionDate: '2026-06-02',
      tags: ['pending-tag'],
      state: 'pending',
    });
    await insertAchievement({
      title: 'Deleting Work',
      completionDate: '2026-06-03',
      tags: ['deleting-tag'],
      state: 'deleting',
    });

    const { payload } = await requestTags('', headers);
    expect(payload.tags).toEqual(['ready-tag']);

    const readyTag = await requestGallery('tag=pending-tag', headers);
    expect(readyTag.payload.items).toEqual([]);
  });

  it('denies unauthenticated tag requests without caching them', async () => {
    const response = await tagsHandler(
      new NextRequest('http://localhost:3000/api/tags', { method: 'GET' })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe(
      'private, no-store, no-cache, must-revalidate'
    );
  });

  it('rejects an overlong selected tag with the existing validation response', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { response, payload } = await requestGallery(
      `tag=${'x'.repeat(25)}`,
      headers
    );

    expect(response.status).toBe(400);
    expect((payload as unknown as { code?: string }).code).toBe('INVALID_TAGS');
  });

  it('returns an empty tag list for an empty archive', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { response, payload } = await requestTags('', headers);

    expect(response.status).toBe(200);
    expect(payload.tags).toEqual([]);
  });
});
