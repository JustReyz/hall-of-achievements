import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, resetDatabase } from '@/lib/db';
import { achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { exportArchive } from '@/lib/operations/export';
import { restoreArchive } from '@/lib/operations/restore';
import { GET as galleryHandler } from '@/app/api/achievements/route';
import {
  GET as getItemHandler,
  PATCH as patchHandler,
} from '@/app/api/achievements/[id]/route';
import {
  isValidThumbnailPosition,
  validateThumbnailPosition,
  ValidationError,
} from '@/lib/validation/achievement';
import { createAuthenticatedHeaders, type AuthenticatedHeaders } from '../helpers/auth-helper';

interface SeededArtwork {
  id: string;
  assetId: string;
  originalKey: string;
  displayKey: string;
  thumbnailKey: string;
  originalBytes: Buffer;
  displayBytes: Buffer;
  thumbnailBytes: Buffer;
  checksum: string;
}

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoa-framing-'));
  tempDirs.push(dir);
  return dir;
}

async function seedArtwork(
  title: string,
  framing?: { x: number; y: number }
): Promise<SeededArtwork> {
  const db = await getDb();
  const storage = getStorage() as MemoryStorageAdapter;
  const id = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const originalBytes = Buffer.from(`original-${id}`, 'utf-8');
  const displayBytes = Buffer.from(`display-${id}`, 'utf-8');
  const thumbnailBytes = Buffer.from(`thumbnail-${id}`, 'utf-8');
  const originalKey = `originals/${id}/original.jpg`;
  const displayKey = `derivatives/${id}/display.webp`;
  const thumbnailKey = `derivatives/${id}/thumb.webp`;
  const checksum = crypto.createHash('sha256').update(originalBytes).digest('hex');

  await storage.putObject(originalKey, originalBytes, { contentType: 'image/jpeg' });
  await storage.putObject(displayKey, displayBytes, { contentType: 'image/webp' });
  await storage.putObject(thumbnailKey, thumbnailBytes, { contentType: 'image/webp' });

  await db.insert(achievements).values({
    id,
    title,
    completionDate: '2026-10-20',
    state: 'ready',
    ...(framing
      ? { thumbnailPositionX: framing.x, thumbnailPositionY: framing.y }
      : {}),
  });

  await db.insert(assets).values({
    id: assetId,
    achievementId: id,
    originalKey,
    displayKey,
    thumbnailKey,
    originalBytes: originalBytes.length,
    mimeType: 'image/jpeg',
    width: 1200,
    height: 900,
    checksum,
  });

  return {
    id,
    assetId,
    originalKey,
    displayKey,
    thumbnailKey,
    originalBytes,
    displayBytes,
    thumbnailBytes,
    checksum,
  };
}

async function getItem(id: string, headers: AuthenticatedHeaders) {
  const request = new NextRequest(`http://localhost:3000/api/achievements/${id}`, {
    method: 'GET',
    headers,
  });
  const response = await getItemHandler(request, { params: Promise.resolve({ id }) });
  return { response, body: await response.json() };
}

async function getGallery(headers: AuthenticatedHeaders) {
  const request = new NextRequest('http://localhost:3000/api/achievements', {
    method: 'GET',
    headers,
  });
  const response = await galleryHandler(request);
  return {
    response,
    body: (await response.json()) as {
      items: Array<{
        id: string;
        thumbnailPositionX: number;
        thumbnailPositionY: number;
      }>;
    },
  };
}

async function patchItem(
  id: string,
  headers: AuthenticatedHeaders,
  body: Record<string, unknown> | string
) {
  const request = new NextRequest(`http://localhost:3000/api/achievements/${id}`, {
    method: 'PATCH',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await patchHandler(request, { params: Promise.resolve({ id }) });
  return {
    response,
    body: (await response.json()) as {
      code?: string;
      thumbnailPositionX?: number;
      thumbnailPositionY?: number;
    },
  };
}

beforeEach(async () => {
  await resetDatabase();
  const storage = getStorage();
  if (storage instanceof MemoryStorageAdapter) {
    storage.clear();
  }
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Integration: thumbnail framing', () => {
  it('accepts only finite numbers from 0 through 1 at the validation boundary', () => {
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      expect(isValidThumbnailPosition(value)).toBe(true);
    }

    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0.001,
      1.001,
      '0.5',
      null,
      undefined,
      true,
      {},
      [],
    ]) {
      expect(isValidThumbnailPosition(value)).toBe(false);
    }

    expect(() => validateThumbnailPosition(Number.NaN, 'x')).toThrow(ValidationError);
    try {
      validateThumbnailPosition(1.5, 'y');
      throw new Error('Expected validation to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('INVALID_THUMBNAIL_POSITION');
    }
  });

  it('exposes centered framing for an existing card by default', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const seeded = await seedArtwork('Centered work');

    const item = await getItem(seeded.id, headers);
    expect(item.response.status).toBe(200);
    expect(item.body.thumbnailPositionX).toBe(0.5);
    expect(item.body.thumbnailPositionY).toBe(0.5);

    const gallery = await getGallery(headers);
    const card = gallery.body.items.find((entry) => entry.id === seeded.id);
    expect(card?.thumbnailPositionX).toBe(0.5);
    expect(card?.thumbnailPositionY).toBe(0.5);
  });

  it('saves non-center framing and returns it from the item and gallery queries', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const seeded = await seedArtwork('Off-center work');

    const patched = await patchItem(seeded.id, headers, {
      thumbnailPositionX: 0.2,
      thumbnailPositionY: 0.8,
    });
    expect(patched.response.status).toBe(200);
    expect(patched.body.thumbnailPositionX).toBe(0.2);
    expect(patched.body.thumbnailPositionY).toBe(0.8);

    const refreshed = await getItem(seeded.id, headers);
    expect(refreshed.body.thumbnailPositionX).toBe(0.2);
    expect(refreshed.body.thumbnailPositionY).toBe(0.8);

    const gallery = await getGallery(headers);
    const card = gallery.body.items.find((entry) => entry.id === seeded.id);
    expect(card?.thumbnailPositionX).toBe(0.2);
    expect(card?.thumbnailPositionY).toBe(0.8);

    const db = await getDb();
    const [stored] = await db
      .select({
        thumbnailPositionX: achievements.thumbnailPositionX,
        thumbnailPositionY: achievements.thumbnailPositionY,
      })
      .from(achievements)
      .where(eq(achievements.id, seeded.id));
    expect(stored).toEqual({ thumbnailPositionX: 0.2, thumbnailPositionY: 0.8 });

    const storage = getStorage() as MemoryStorageAdapter;
    const [original, display, thumbnail] = await Promise.all([
      storage.getObject(seeded.originalKey),
      storage.getObject(seeded.displayKey),
      storage.getObject(seeded.thumbnailKey),
    ]);
    expect(original.data.equals(seeded.originalBytes)).toBe(true);
    expect(display.data.equals(seeded.displayBytes)).toBe(true);
    expect(thumbnail.data.equals(seeded.thumbnailBytes)).toBe(true);

    const [asset] = await db.select().from(assets).where(eq(assets.id, seeded.assetId));
    expect(asset?.checksum).toBe(seeded.checksum);
    expect(asset?.originalBytes).toBe(seeded.originalBytes.length);
  });

  it('rejects invalid framing values at the API boundary without changing stored values', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const seeded = await seedArtwork('Guarded work');

    const invalidPayloads: Array<Record<string, unknown> | string> = [
      { thumbnailPositionX: '0.5' },
      { thumbnailPositionX: null },
      { thumbnailPositionX: -0.01 },
      { thumbnailPositionX: 1.01 },
      { thumbnailPositionY: '0.5' },
      { thumbnailPositionY: null },
      { thumbnailPositionY: Number.POSITIVE_INFINITY },
      '{"thumbnailPositionX":1e999}',
      '{"thumbnailPositionY":1e999}',
    ];

    for (const payload of invalidPayloads) {
      const result = await patchItem(seeded.id, headers, payload);
      expect(result.response.status).toBe(400);
      expect(result.body.code).toBe('INVALID_THUMBNAIL_POSITION');
    }

    const refreshed = await getItem(seeded.id, headers);
    expect(refreshed.body.thumbnailPositionX).toBe(0.5);
    expect(refreshed.body.thumbnailPositionY).toBe(0.5);

    const db = await getDb();
    const [stored] = await db
      .select({
        thumbnailPositionX: achievements.thumbnailPositionX,
        thumbnailPositionY: achievements.thumbnailPositionY,
      })
      .from(achievements)
      .where(eq(achievements.id, seeded.id));
    expect(stored).toEqual({ thumbnailPositionX: 0.5, thumbnailPositionY: 0.5 });
  });

  it('enforces the range at the database boundary', async () => {
    const db = await getDb();
    const seeded = await seedArtwork('Constraint work');

    await expect(
      db.insert(achievements).values({
        title: 'Out of range insert',
        completionDate: '2026-10-21',
        state: 'ready',
        thumbnailPositionX: 1.5,
      })
    ).rejects.toThrow(/check constraint/);

    await expect(
      db
        .update(achievements)
        .set({ thumbnailPositionY: -0.01 })
        .where(eq(achievements.id, seeded.id))
    ).rejects.toThrow(/check constraint/);
  });

  it('writes archive version 3 and preserves framing through export and restore', async () => {
    let db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;
    const seeded = await seedArtwork('Export framing', { x: 0.2, y: 0.8 });

    const exportDir = createTempDir();
    const exported = await exportArchive({ outputDir: exportDir, db, storage });
    expect(exported.manifest.version).toBe(3);

    const metadata = JSON.parse(
      fs.readFileSync(path.join(exportDir, 'metadata', 'achievements.json'), 'utf-8')
    ) as Array<{ id: string; thumbnailPositionX: number; thumbnailPositionY: number }>;
    expect(metadata.find((entry) => entry.id === seeded.id)).toMatchObject({
      thumbnailPositionX: 0.2,
      thumbnailPositionY: 0.8,
    });

    db = await resetDatabase();
    storage.clear();
    await restoreArchive({ inputDir: exportDir, db, storage });

    const [restored] = await db
      .select({
        thumbnailPositionX: achievements.thumbnailPositionX,
        thumbnailPositionY: achievements.thumbnailPositionY,
      })
      .from(achievements)
      .where(eq(achievements.id, seeded.id));
    expect(restored?.thumbnailPositionX).toBeCloseTo(0.2, 5);
    expect(restored?.thumbnailPositionY).toBeCloseTo(0.8, 5);

    const [asset] = await db.select().from(assets).where(eq(assets.id, seeded.assetId));
    expect(asset?.checksum).toBe(seeded.checksum);
  });

  it('restores version 1 archives with centered defaults', async () => {
    let db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;
    const seeded = await seedArtwork('Version one framing', { x: 0.9, y: 0.1 });

    const exportDir = createTempDir();
    await exportArchive({ outputDir: exportDir, db, storage });

    const metadataPath = path.join(exportDir, 'metadata', 'achievements.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Array<
      Record<string, unknown>
    >;
    for (const entry of metadata) {
      entry.thumbnailPositionX = 0.9;
      entry.thumbnailPositionY = 0.1;
    }
    const metadataBuffer = Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8');
    fs.writeFileSync(metadataPath, metadataBuffer);

    const manifestPath = path.join(exportDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      version: number;
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    manifest.version = 1;
    const metadataEntry = manifest.files.find(
      (entry) => entry.path === 'metadata/achievements.json'
    );
    if (!metadataEntry) throw new Error('Missing achievements metadata entry');
    metadataEntry.size = metadataBuffer.length;
    metadataEntry.sha256 = crypto.createHash('sha256').update(metadataBuffer).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    db = await resetDatabase();
    storage.clear();
    await restoreArchive({ inputDir: exportDir, db, storage });

    const [restored] = await db
      .select({
        thumbnailPositionX: achievements.thumbnailPositionX,
        thumbnailPositionY: achievements.thumbnailPositionY,
      })
      .from(achievements)
      .where(eq(achievements.id, seeded.id));
    expect(restored).toEqual({ thumbnailPositionX: 0.5, thumbnailPositionY: 0.5 });
  });

  it('rejects a newer archive version before changing storage or the database', async () => {
    let db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;
    await seedArtwork('Future archive');

    const exportDir = createTempDir();
    await exportArchive({ outputDir: exportDir, db, storage });

    const manifestPath = path.join(exportDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { version: number };
    manifest.version = 4;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    db = await resetDatabase();
    storage.clear();

    await expect(restoreArchive({ inputDir: exportDir, db, storage })).rejects.toThrow(
      /Unsupported manifest schema version/
    );

    const rows = await db.select().from(achievements);
    expect(rows.length).toBe(0);
    expect(storage.getStoredCount()).toBe(0);
  });
});
