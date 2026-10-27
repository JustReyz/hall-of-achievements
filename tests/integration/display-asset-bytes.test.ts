import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { resetDatabase, getDb } from '@/lib/db';
import { achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { GET as getAssetsHandler } from '@/app/api/achievements/[id]/assets/route';
import { createAuthenticatedHeaders, type AuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestWebp } from '../helpers/image-fixtures';

interface SeededAsset {
  id: string;
  displayKey: string;
  originalKey: string;
  displayBytes: Buffer;
  originalBytes: Buffer;
}

async function seedAsset(options: {
  displayBytes?: Buffer;
  originalBytes?: Buffer;
  writeDisplay?: boolean;
} = {}): Promise<SeededAsset> {
  const db = await getDb();
  const storage = getStorage() as MemoryStorageAdapter;
  const id = crypto.randomUUID();
  const originalBytes = options.originalBytes ?? Buffer.from(`original-${id}`);
  const displayBytes = options.displayBytes ?? (await createTestWebp(320, 240));
  const originalKey = `originals/${id}/original.jpg`;
  const displayKey = `derivatives/${id}/display.webp`;
  const thumbnailKey = `derivatives/${id}/thumb.webp`;

  await storage.putObject(originalKey, originalBytes, { contentType: 'image/jpeg' });
  if (options.writeDisplay !== false) {
    await storage.putObject(displayKey, displayBytes, { contentType: 'image/webp' });
  }

  await db.insert(achievements).values({
    id,
    title: 'Inline display test',
    completionDate: '2026-10-20',
    state: 'ready',
  });

  await db.insert(assets).values({
    id: crypto.randomUUID(),
    achievementId: id,
    originalKey,
    displayKey,
    thumbnailKey,
    originalBytes: originalBytes.length,
    mimeType: 'image/jpeg',
    width: 320,
    height: 240,
    checksum: crypto.createHash('sha256').update(originalBytes).digest('hex'),
  });

  return { id, displayKey, originalKey, displayBytes, originalBytes };
}

function requestAssets(
  id: string,
  query: string,
  headers: AuthenticatedHeaders | Record<string, string> = {}
) {
  const request = new NextRequest(
    `http://localhost:3000/api/achievements/${id}/assets?${query}`,
    { method: 'GET', headers }
  );
  return getAssetsHandler(request, { params: Promise.resolve({ id }) });
}

beforeEach(async () => {
  await resetDatabase();
  const storage = getStorage();
  if (storage instanceof MemoryStorageAdapter) storage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Integration: inline display asset bytes', () => {
  it('serves the sanitized display derivative with private no-store headers', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const seeded = await seedAsset();

    const response = await requestAssets(seeded.id, 'type=display&delivery=inline', headers);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-length')).toBe(String(seeded.displayBytes.length));

    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(seeded.displayBytes)).toBe(true);
    expect(body.equals(seeded.originalBytes)).toBe(false);
  });

  it('requires an authenticated session', async () => {
    const seeded = await seedAsset();

    const response = await requestAssets(seeded.id, 'type=display&delivery=inline');

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
  });

  it('rejects inline originals, thumbnails, and client-supplied keys or URLs', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const seeded = await seedAsset();
    const invalidQueries = [
      'type=original&delivery=inline',
      'type=thumbnail&delivery=inline',
      'delivery=inline',
      'type=display&delivery=inline&key=originals%2Fanything',
      'type=display&delivery=inline&assetKey=anything',
      'type=display&delivery=inline&url=https%3A%2F%2Fexample.test%2Fimage.webp',
    ];

    for (const query of invalidQueries) {
      const response = await requestAssets(seeded.id, query, headers);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('INVALID_INLINE_ASSET_REQUEST');
    }
  });

  it('refuses a display derivative above the 4 MiB response bound', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1);
    oversized.write('RIFF', 0, 'ascii');
    oversized.write('WEBP', 8, 'ascii');
    const seeded = await seedAsset({ displayBytes: oversized });

    const response = await requestAssets(seeded.id, 'type=display&delivery=inline', headers);

    expect(response.status).toBe(413);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('DISPLAY_TOO_LARGE');
  });

  it('refuses invalid derivative bytes and never falls back to the original', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const seeded = await seedAsset({
      displayBytes: Buffer.from('not a webp image'),
      originalBytes: await createTestWebp(64, 64),
    });
    const storage = getStorage() as MemoryStorageAdapter;
    const getObject = vi.spyOn(storage, 'getObject');

    const response = await requestAssets(seeded.id, 'type=display&delivery=inline', headers);

    expect(response.status).toBe(502);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('INVALID_DISPLAY_DERIVATIVE');
    expect(getObject).toHaveBeenCalledWith(seeded.displayKey);
    expect(getObject).not.toHaveBeenCalledWith(seeded.originalKey);
  });

  it('reports a missing display derivative instead of loading the original', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const seeded = await seedAsset({ writeDisplay: false });
    const storage = getStorage() as MemoryStorageAdapter;
    const getObject = vi.spyOn(storage, 'getObject');

    const response = await requestAssets(seeded.id, 'type=display&delivery=inline', headers);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('DISPLAY_NOT_FOUND');
    expect(getObject).toHaveBeenCalledWith(seeded.displayKey);
    expect(getObject).not.toHaveBeenCalledWith(seeded.originalKey);
  });
});
