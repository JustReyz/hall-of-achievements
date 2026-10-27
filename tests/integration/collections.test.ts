import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, achievements, collectionItems, collections } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { exportArchive } from '@/lib/operations/export';
import { restoreArchive } from '@/lib/operations/restore';
import { POST as createAchievementHandler } from '@/app/api/achievements/route';
import {
  GET as listCollectionsHandler,
  POST as createCollectionHandler,
} from '@/app/api/collections/route';
import {
  PATCH as renameCollectionHandler,
  DELETE as deleteCollectionHandler,
  GET as collectionDetailHandler,
} from '@/app/api/collections/[id]/route';
import {
  GET as collectionItemsHandler,
  PUT as orderHandler,
} from '@/app/api/collections/[id]/items/route';
import { DELETE as trashHandler } from '@/app/api/achievements/[id]/route';
import { POST as restoreHandler } from '@/app/api/achievements/[id]/restore/route';
import { DELETE as purgeHandler } from '@/app/api/achievements/[id]/purge/route';
import { GET as tagsHandler } from '@/app/api/tags/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestJpeg } from '../helpers/image-fixtures';

const BASE = 'http://localhost:3000';

interface CollectionRow {
  id: string;
  name: string;
  revision: number;
  memberCount: number;
}

interface CuratedPage {
  items: Array<{ id: string; title: string; position: number }>;
  nextCursor: string | null;
  hasMore: boolean;
  revision: number;
  name: string;
}

async function createArtwork(
  headers: Record<string, string>,
  title: string,
  options: { completionDate?: string; tags?: string[] } = {}
): Promise<string> {
  const db = await getDb();
  const storage = getStorage() as MemoryStorageAdapter;
  const jpeg = await createTestJpeg(240, 180);
  const intentId = crypto.randomUUID();
  const quarantineKey = `quarantine/${intentId}.jpg`;
  await db.insert(uploadIntents).values({
    id: intentId,
    tokenHash: 'test_hash',
    fileName: 'piece.jpg',
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
      body: JSON.stringify({
        title,
        completionDate: options.completionDate ?? '2026-10-20',
        tags: options.tags ?? [],
        intentId,
      }),
    })
  );
  return ((await response.json()) as { id: string }).id;
}

async function createCollection(
  headers: Record<string, string>,
  name: string
): Promise<CollectionRow> {
  const response = await createCollectionHandler(
    new NextRequest(`${BASE}/api/collections`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
    })
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { collection: CollectionRow }).collection;
}

async function writeOrder(
  headers: Record<string, string>,
  collectionId: string,
  revision: number,
  achievementIds: string[]
) {
  const response = await orderHandler(
    new NextRequest(`${BASE}/api/collections/${collectionId}/items`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ revision, achievementIds }),
    }),
    { params: Promise.resolve({ id: collectionId }) }
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function readPage(
  headers: Record<string, string>,
  collectionId: string,
  query: Record<string, string> = {}
) {
  const params = new URLSearchParams({ limit: '2', ...query });
  const response = await collectionItemsHandler(
    new NextRequest(`${BASE}/api/collections/${collectionId}/items?${params}`, { headers }),
    { params: Promise.resolve({ id: collectionId }) }
  );
  return { status: response.status, body: (await response.json()) as CuratedPage & Record<string, unknown> };
}

beforeEach(async () => {
  await resetDatabase();
  (getStorage() as MemoryStorageAdapter).clear();
});

describe('Integration: ordered collections', () => {
  it('creates, renames, lists, and deletes a collection without touching artwork', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const artworkId = await createArtwork(headers, 'Curated Piece');
    const collection = await createCollection(headers, '  Autumn Series  ');
    expect(collection.name).toBe('Autumn Series');

    const listed = (await (
      await listCollectionsHandler(new NextRequest(`${BASE}/api/collections`, { headers }))
    ).json()) as { collections: CollectionRow[] };
    expect(listed.collections.map((row) => row.name)).toEqual(['Autumn Series']);

    await writeOrder(headers, collection.id, collection.revision, [artworkId]);
    const renamed = await renameCollectionHandler(
      new NextRequest(`${BASE}/api/collections/${collection.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: 'Autumn Series II' }),
      }),
      { params: Promise.resolve({ id: collection.id }) }
    );
    expect(renamed.status).toBe(200);

    const removed = await deleteCollectionHandler(
      new NextRequest(`${BASE}/api/collections/${collection.id}`, { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: collection.id }) }
    );
    expect(removed.status).toBe(200);

    const db = await getDb();
    expect(await db.select().from(collectionItems)).toHaveLength(0);
    const [artwork] = await db.select().from(achievements).where(eq(achievements.id, artworkId));
    expect(artwork?.title).toBe('Curated Piece');
  });

  it('replaces the complete order, bumps the revision, and rejects a stale write atomically', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const first = await createArtwork(headers, 'First');
    const second = await createArtwork(headers, 'Second');
    const third = await createArtwork(headers, 'Third');
    const collection = await createCollection(headers, 'Ordered');

    const initial = await writeOrder(headers, collection.id, collection.revision, [first, second]);
    expect(initial.status).toBe(200);
    expect(initial.body.revision).toBe(collection.revision + 1);

    const reordered = await writeOrder(headers, collection.id, collection.revision + 1, [
      second,
      first,
      third,
    ]);
    expect(reordered.status).toBe(200);

    const detail = (await (
      await collectionDetailHandler(
        new NextRequest(`${BASE}/api/collections/${collection.id}`, { headers }),
        { params: Promise.resolve({ id: collection.id }) }
      )
    ).json()) as { revision: number; items: Array<{ achievementId: string; position: number }> };
    expect(detail.items.map((item) => item.achievementId)).toEqual([second, first, third]);
    expect(detail.items.map((item) => item.position)).toEqual([0, 1, 2]);

    // The old revision is stale; nothing changes.
    const stale = await writeOrder(headers, collection.id, collection.revision, [first]);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('REVISION_CONFLICT');

    const unchanged = (await (
      await collectionDetailHandler(
        new NextRequest(`${BASE}/api/collections/${collection.id}`, { headers }),
        { params: Promise.resolve({ id: collection.id }) }
      )
    ).json()) as { revision: number; items: Array<{ achievementId: string }> };
    expect(unchanged.items.map((item) => item.achievementId)).toEqual([second, first, third]);
    expect(unchanged.revision).toBe(reordered.body.revision);
  });

  it('rejects duplicates, unknown artwork, and newly trashed additions', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const first = await createArtwork(headers, 'Member One');
    const trashed = await createArtwork(headers, 'Member Two');
    const collection = await createCollection(headers, 'Validation');

    const duplicate = await writeOrder(headers, collection.id, collection.revision, [first, first]);
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe('DUPLICATE_MEMBER');

    const unknown = await writeOrder(headers, collection.id, collection.revision, [
      crypto.randomUUID(),
    ]);
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('UNKNOWN_ARTWORK');

    await trashHandler(
      new NextRequest(`${BASE}/api/achievements/${trashed}`, { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: trashed }) }
    );

    const trashedAdd = await writeOrder(headers, collection.id, collection.revision, [trashed]);
    expect(trashedAdd.status).toBe(409);
    expect(trashedAdd.body.code).toBe('INVALID_MEMBER');

    const oversized = await writeOrder(
      headers,
      collection.id,
      collection.revision,
      Array.from({ length: 201 }, () => crypto.randomUUID())
    );
    expect(oversized.status).toBe(400);
    expect(oversized.body.code).toBe('COLLECTION_LIMIT');
  });

  it('paginates by curated position and rejects cursors from another revision or collection', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      ids.push(
        await createArtwork(headers, `Piece ${index + 1}`, {
          completionDate: `2026-10-0${index + 1}`,
          tags: index % 2 === 0 ? ['curated'] : [],
        })
      );
    }
    const collection = await createCollection(headers, 'Paged');
    await writeOrder(headers, collection.id, collection.revision, ids);

    const firstPage = await readPage(headers, collection.id);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items.map((item) => item.id)).toEqual([ids[0], ids[1]]);
    expect(firstPage.body.nextCursor).toContain(collection.id);

    const secondPage = await readPage(headers, collection.id, {
      cursor: String(firstPage.body.nextCursor),
    });
    expect(secondPage.body.items.map((item) => item.id)).toEqual([ids[2], ids[3]]);

    const thirdPage = await readPage(headers, collection.id, {
      cursor: String(secondPage.body.nextCursor),
    });
    expect(thirdPage.body.items.map((item) => item.id)).toEqual([ids[4]]);
    expect(thirdPage.body.hasMore).toBe(false);
    expect(thirdPage.body.nextCursor).toBeNull();

    // Date order must never replace curated order.
    const detail = (await (
      await collectionDetailHandler(
        new NextRequest(`${BASE}/api/collections/${collection.id}`, { headers }),
        { params: Promise.resolve({ id: collection.id }) }
      )
    ).json()) as { revision: number };
    const oldCursor = String(firstPage.body.nextCursor);
    await writeOrder(headers, collection.id, detail.revision, [
      ids[4]!,
      ids[3]!,
      ids[2]!,
      ids[1]!,
      ids[0]!,
    ]);

    const staleCursor = await readPage(headers, collection.id, { cursor: oldCursor });
    expect(staleCursor.status).toBe(409);
    expect(staleCursor.body.code).toBe('CURSOR_STALE');

    const foreignCursor = oldCursor.replace(collection.id, crypto.randomUUID());
    const foreign = await readPage(headers, collection.id, { cursor: foreignCursor });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('CURSOR_INVALID');

    const filtered = await readPage(headers, collection.id, { tag: 'curated', limit: '24' });
    expect(filtered.body.items.map((item) => item.id)).toEqual([ids[4], ids[2], ids[0]]);
    expect(filtered.body.items.map((item) => item.position)).toEqual([0, 2, 4]);
  });

  it('keeps membership through Trash and restores the original position', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const first = await createArtwork(headers, 'Stays Visible');
    const second = await createArtwork(headers, 'Goes To Trash');
    const collection = await createCollection(headers, 'Trash Aware');
    await writeOrder(headers, collection.id, collection.revision, [first, second]);

    const before = (await (
      await collectionDetailHandler(
        new NextRequest(`${BASE}/api/collections/${collection.id}`, { headers }),
        { params: Promise.resolve({ id: collection.id }) }
      )
    ).json()) as { revision: number };
    const beforeRevision = before.revision;

    await trashHandler(
      new NextRequest(`${BASE}/api/achievements/${second}`, { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: second }) }
    );

    const db = await getDb();
    const [row] = await db
      .select()
      .from(collections)
      .where(eq(collections.id, collection.id));
    expect(row?.revision).toBe(beforeRevision + 1);

    const pageDuringTrash = await readPage(headers, collection.id, { limit: '24' });
    expect(pageDuringTrash.body.items.map((item) => item.id)).toEqual([first]);

    const editorDuringTrash = (await (
      await collectionDetailHandler(
        new NextRequest(`${BASE}/api/collections/${collection.id}`, { headers }),
        { params: Promise.resolve({ id: collection.id }) }
      )
    ).json()) as { items: Array<{ achievementId: string; trashedAt: string | null }> };
    expect(editorDuringTrash.items).toHaveLength(2);
    expect(editorDuringTrash.items[1]?.achievementId).toBe(second);
    expect(editorDuringTrash.items[1]?.trashedAt).not.toBeNull();

    // A reorder that preserves the trashed member is allowed.
    const reorder = await writeOrder(headers, collection.id, beforeRevision + 1, [second, first]);
    expect(reorder.status).toBe(200);

    await restoreHandler(
      new NextRequest(`${BASE}/api/achievements/${second}/restore`, {
        method: 'POST',
        headers,
      }),
      { params: Promise.resolve({ id: second }) }
    );

    const editorAfterRestore = (await (
      await collectionDetailHandler(
        new NextRequest(`${BASE}/api/collections/${collection.id}`, { headers }),
        { params: Promise.resolve({ id: collection.id }) }
      )
    ).json()) as { items: Array<{ achievementId: string }> };
    expect(editorAfterRestore.items.map((item) => item.achievementId)).toEqual([second, first]);

    const pageAfterRestore = await readPage(headers, collection.id, { limit: '24' });
    expect(pageAfterRestore.body.items.map((item) => item.id)).toEqual([second, first]);

    // Permanent purge removes the membership and bumps the revision.
    await trashHandler(
      new NextRequest(`${BASE}/api/achievements/${second}`, { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: second }) }
    );
    const purge = await purgeHandler(
      new NextRequest(`${BASE}/api/achievements/${second}/purge`, { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: second }) }
    );
    expect(purge.status).toBe(200);

    const memberships = await db
      .select()
      .from(collectionItems)
      .where(eq(collectionItems.collectionId, collection.id));
    expect(memberships.map((item) => item.achievementId)).toEqual([first]);
  });

  it('scopes tags to the selected collection', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const inside = await createArtwork(headers, 'Inside', { tags: ['inside-tag'] });
    await createArtwork(headers, 'Outside', { tags: ['outside-tag'] });
    const collection = await createCollection(headers, 'Tag Scope');
    await writeOrder(headers, collection.id, collection.revision, [inside]);

    const response = await tagsHandler(
      new NextRequest(`${BASE}/api/tags?collectionId=${collection.id}`, { headers })
    );
    const payload = (await response.json()) as { tags: string[] };
    expect(payload.tags).toEqual(['inside-tag']);
  });

  it('round-trips collections, order, and trashed members through archive version 4', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const first = await createArtwork(headers, 'Archive One');
    const second = await createArtwork(headers, 'Archive Two');
    const collection = await createCollection(headers, 'Archived Series');
    await writeOrder(headers, collection.id, collection.revision, [second, first]);

    await trashHandler(
      new NextRequest(`${BASE}/api/achievements/${first}`, { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: first }) }
    );

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collections-roundtrip-'));
    const exported = await exportArchive({ outputDir, force: true });
    expect(exported.manifest.version).toBe(4);
    expect(
      exported.manifest.files.some((entry) => entry.path === 'metadata/collections.json')
    ).toBe(true);

    await resetDatabase();
    (getStorage() as MemoryStorageAdapter).clear();

    const restored = await restoreArchive({ inputDir: outputDir });
    expect(restored.achievementsRestored).toBe(2);

    const db = await getDb();
    const [restoredCollection] = await db.select().from(collections);
    expect(restoredCollection?.name).toBe('Archived Series');

    const memberships = await db
      .select()
      .from(collectionItems)
      .orderBy(asc(collectionItems.position));
    expect(memberships.map((item) => item.achievementId)).toEqual([second, first]);

    const [trashedMember] = await db
      .select()
      .from(achievements)
      .where(and(eq(achievements.id, first)));
    expect(trashedMember?.trashedAt).toBeInstanceOf(Date);

    fs.rmSync(outputDir, { recursive: true, force: true });
  });
});
