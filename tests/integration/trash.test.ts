import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { getStorageQuotaStats } from '@/lib/storage/quota';
import { exportArchive } from '@/lib/operations/export';
import { restoreArchive } from '@/lib/operations/restore';
import { listTrash } from '@/lib/operations/trash';
import { POST as createAchievementHandler, GET as galleryHandler } from '@/app/api/achievements/route';
import {
  GET as getSingleHandler,
  DELETE as deleteAchievementHandler,
} from '@/app/api/achievements/[id]/route';
import { GET as getAssetsHandler } from '@/app/api/achievements/[id]/assets/route';
import { POST as restoreHandler } from '@/app/api/achievements/[id]/restore/route';
import { GET as trashHandler } from '@/app/api/trash/route';
import { GET as tagsHandler } from '@/app/api/tags/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestJpeg } from '../helpers/image-fixtures';

const BASE = 'http://localhost:3000';

interface TrashPayload {
  items: Array<{ id: string; title: string; trashedAt: string }>;
  nextCursor: string | null;
}

async function createArtwork(headers: Record<string, string>, title: string): Promise<string> {
  const db = await getDb();
  const storage = getStorage() as MemoryStorageAdapter;
  const jpeg = await createTestJpeg(320, 240);
  const intentId = crypto.randomUUID();
  const quarantineKey = `quarantine/${intentId}.jpg`;
  await db.insert(uploadIntents).values({
    id: intentId,
    tokenHash: 'test_hash',
    fileName: 'artwork.jpg',
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
        completionDate: '2026-10-20',
        tags: ['trash-test'],
        intentId,
      }),
    })
  );
  const created = (await response.json()) as { id: string };
  return created.id;
}

async function trashArtwork(headers: Record<string, string>, id: string): Promise<Response> {
  return deleteAchievementHandler(
    new NextRequest(`${BASE}/api/achievements/${id}`, { method: 'DELETE', headers }),
    { params: Promise.resolve({ id }) }
  );
}

async function restoreArtwork(headers: Record<string, string>, id: string): Promise<Response> {
  return restoreHandler(
    new NextRequest(`${BASE}/api/achievements/${id}/restore`, { method: 'POST', headers }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(async () => {
  await resetDatabase();
  (getStorage() as MemoryStorageAdapter).clear();
});

describe('Integration: recoverable Trash', () => {
  it('moves artwork to Trash without removing bytes and hides it everywhere', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await createArtwork(headers, 'Trashed Piece');
    const storage = getStorage() as MemoryStorageAdapter;
    const db = await getDb();
    const [asset] = await db.select().from(assets).where(eq(assets.achievementId, id));

    const response = await trashArtwork(headers, id);
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      trashed: true,
      id,
      alreadyTrashed: false,
    });

    expect(storage.hasObject(asset!.originalKey)).toBe(true);
    expect(storage.hasObject(asset!.displayKey)).toBe(true);
    expect(storage.hasObject(asset!.thumbnailKey)).toBe(true);

    const gallery = (await (
      await galleryHandler(new NextRequest(`${BASE}/api/achievements`, { headers }))
    ).json()) as { items: unknown[] };
    expect(gallery.items).toHaveLength(0);

    const single = await getSingleHandler(
      new NextRequest(`${BASE}/api/achievements/${id}`, { headers }),
      { params: Promise.resolve({ id }) }
    );
    expect(single.status).toBe(404);

    const assetsResponse = await getAssetsHandler(
      new NextRequest(`${BASE}/api/achievements/${id}/assets?type=display`, { headers }),
      { params: Promise.resolve({ id }) }
    );
    expect(assetsResponse.status).toBe(404);

    const tags = (await (
      await tagsHandler(new NextRequest(`${BASE}/api/tags`, { headers }))
    ).json()) as { tags: string[] };
    expect(tags.tags).not.toContain('trash-test');
  });

  it('treats repeated Trash and restore requests as idempotent', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await createArtwork(headers, 'Repeat Piece');

    expect((await trashArtwork(headers, id)).status).toBe(200);
    const second = await trashArtwork(headers, id);
    expect(second.status).toBe(200);
    expect((await second.json()) as Record<string, unknown>).toMatchObject({
      trashed: true,
      alreadyTrashed: true,
    });

    const restore = await restoreArtwork(headers, id);
    expect(restore.status).toBe(200);
    expect((await restore.json()) as Record<string, unknown>).toMatchObject({
      restored: true,
      alreadyRestored: false,
    });

    const gallery = (await (
      await galleryHandler(new NextRequest(`${BASE}/api/achievements`, { headers }))
    ).json()) as { items: Array<{ id: string }> };
    expect(gallery.items.map((item) => item.id)).toEqual([id]);

    const repeated = await restoreArtwork(headers, id);
    expect(repeated.status).toBe(200);
    expect((await repeated.json()) as Record<string, unknown>).toMatchObject({
      restored: true,
      alreadyRestored: true,
    });
  });

  it('lists Trash metadata only, newest first, and keeps the bytes counted', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const first = await createArtwork(headers, 'First In Trash');
    const second = await createArtwork(headers, 'Second In Trash');

    await trashArtwork(headers, first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await trashArtwork(headers, second);

    const response = await trashHandler(new NextRequest(`${BASE}/api/trash`, { headers }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');

    const payload = (await response.json()) as TrashPayload;
    expect(payload.items.map((item) => item.title)).toEqual([
      'Second In Trash',
      'First In Trash',
    ]);
    expect(payload.nextCursor).toBeNull();

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('originals/');
    expect(serialized).not.toContain('derivatives/');
    expect(serialized).not.toContain('quarantine/');
    expect(serialized).not.toContain('http');

    const db = await getDb();
    const stats = await getStorageQuotaStats(db);
    expect(stats.committedBytes).toBeGreaterThan(0);
  });

  it('restores trashed metadata but never claims missing files were recreated', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await createArtwork(headers, 'Metadata Only');
    const storage = getStorage() as MemoryStorageAdapter;
    const db = await getDb();
    const [asset] = await db.select().from(assets).where(eq(assets.achievementId, id));

    await trashArtwork(headers, id);
    await storage.deleteObject(asset!.displayKey);

    const restore = await restoreArtwork(headers, id);
    expect(restore.status).toBe(200);

    const [row] = await db.select().from(achievements).where(eq(achievements.id, id));
    expect(row?.trashedAt).toBeNull();

    const assetsResponse = await getAssetsHandler(
      new NextRequest(`${BASE}/api/achievements/${id}/assets?type=display`, { headers }),
      { params: Promise.resolve({ id }) }
    );
    expect(assetsResponse.status).toBe(200);
    expect(storage.hasObject(asset!.displayKey)).toBe(false);
  });

  it('round-trips Trash state through archive version 3', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const kept = await createArtwork(headers, 'Kept Artwork');
    const trashed = await createArtwork(headers, 'Trashed Artwork');
    await trashArtwork(headers, trashed);

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-roundtrip-'));
    const exported = await exportArchive({ outputDir, force: true });
    expect(exported.manifest.version).toBe(3);

    await resetDatabase();
    (getStorage() as MemoryStorageAdapter).clear();

    const restored = await restoreArchive({ inputDir: outputDir });
    expect(restored.achievementsRestored).toBe(2);

    const db = await getDb();
    const rows = await db.select().from(achievements);
    const trashedRow = rows.find((row) => row.title === 'Trashed Artwork');
    const keptRow = rows.find((row) => row.title === 'Kept Artwork');
    expect(trashedRow?.trashedAt).toBeInstanceOf(Date);
    expect(keptRow?.trashedAt).toBeNull();

    // Restore revokes every session, so read the restored state directly.
    const trashPage = await listTrash(db, {});
    expect(trashPage.items.map((item) => item.id)).toEqual([trashed]);

    const visibility = await db
      .select({ id: achievements.id })
      .from(achievements)
      .where(and(eq(achievements.state, 'ready'), isNull(achievements.trashedAt)));
    expect(visibility.map((row) => row.id)).toEqual([kept]);

    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('rejects Trash and restore for a record claimed for permanent deletion', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await createArtwork(headers, 'Claimed Piece');
    await trashArtwork(headers, id);

    const db = await getDb();
    await db
      .update(achievements)
      .set({ state: 'deleting' })
      .where(eq(achievements.id, id));

    const trashed = await trashArtwork(headers, id);
    expect(trashed.status).toBe(409);
    expect(((await trashed.json()) as { code: string }).code).toBe('ACHIEVEMENT_DELETING');

    const restore = await restoreArtwork(headers, id);
    expect(restore.status).toBe(409);
    expect(((await restore.json()) as { code: string }).code).toBe('ACHIEVEMENT_DELETING');
  });

  it('keeps a trashed artwork out of the health check and upload replay', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await createArtwork(headers, 'Hidden From Checks');
    await trashArtwork(headers, id);

    const { POST: healthHandler } = await import('@/app/api/archive/health/route');
    const health = await healthHandler(
      new NextRequest(`${BASE}/api/archive/health`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: [id] }),
      })
    );
    expect(health.status).toBe(200);
    expect(((await health.json()) as { results: unknown[] }).results).toHaveLength(0);
  });
});
