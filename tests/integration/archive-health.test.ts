import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetDatabase, getDb } from '@/lib/db';
import { achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { StorageError } from '@/lib/storage/adapter';
import { POST as healthHandler } from '@/app/api/archive/health/route';
import type { AchievementHealth } from '@/lib/storage/health';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';

const BASE = 'http://localhost:3000';

interface HealthPayload {
  results: AchievementHealth[];
}

async function insertAchievement(input: {
  title: string;
  completionDate: string;
  state?: 'pending' | 'ready' | 'deleting';
}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.insert(achievements).values({
    id,
    title: input.title,
    completionDate: input.completionDate,
    notes: '',
    tags: [],
    state: input.state ?? 'ready',
  });
  return id;
}

function keysFor(id: string) {
  return {
    original: `originals/${id}/original.jpg`,
    display: `derivatives/${id}/display.webp`,
    thumbnail: `derivatives/${id}/thumb.webp`,
  };
}

async function attachAsset(
  achievementId: string,
  keys: ReturnType<typeof keysFor> = keysFor(achievementId)
): Promise<void> {
  const db = await getDb();
  await db.insert(assets).values({
    achievementId,
    originalKey: keys.original,
    displayKey: keys.display,
    thumbnailKey: keys.thumbnail,
    originalBytes: 1024,
    mimeType: 'image/jpeg',
    width: 800,
    height: 800,
    checksum: 'a'.repeat(64),
  });
}

async function putObjects(
  storage: MemoryStorageAdapter,
  keys: ReturnType<typeof keysFor>,
  present: { original?: boolean; display?: boolean; thumbnail?: boolean } = {}
): Promise<void> {
  if (present.original !== false) {
    await storage.putObject(keys.original, Buffer.from('original-bytes'), {
      contentType: 'image/jpeg',
    });
  }
  if (present.display !== false) {
    await storage.putObject(keys.display, Buffer.from('display-bytes'), {
      contentType: 'image/webp',
    });
  }
  if (present.thumbnail !== false) {
    await storage.putObject(keys.thumbnail, Buffer.from('thumb-bytes'), {
      contentType: 'image/webp',
    });
  }
}

function memoryStorage(): MemoryStorageAdapter {
  const storage = getStorage();
  if (!(storage instanceof MemoryStorageAdapter)) {
    throw new Error('Expected MemoryStorageAdapter in tests');
  }
  return storage;
}

async function postHealth(
  body: unknown,
  headers: Record<string, string>
): Promise<{ response: Response; payload: HealthPayload }> {
  const response = await healthHandler(
    new NextRequest(`${BASE}/api/archive/health`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
  return { response, payload: (await response.json()) as HealthPayload };
}

beforeEach(async () => {
  await resetDatabase();
  memoryStorage().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Integration: POST /api/archive/health', () => {
  it('reports a missing original with intact derivatives and never calls getObject', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await insertAchievement({ title: 'Harbor at Dusk', completionDate: '2026-06-03' });
    const keys = keysFor(id);
    await attachAsset(id, keys);
    const storage = memoryStorage();
    await putObjects(storage, keys, { original: false });

    const getObject = vi.spyOn(storage, 'getObject');
    const { response, payload } = await postHealth({ ids: [id] }, headers);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toMatchObject({
      id,
      title: 'Harbor at Dusk',
      completionDate: '2026-06-03',
      linkage: 'present',
      original: 'missing',
      display: 'present',
      thumbnail: 'present',
    });
    expect(new Date(payload.results[0]!.checkedAt).toISOString()).toBe(payload.results[0]!.checkedAt);
    expect(getObject).not.toHaveBeenCalled();

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('originals/');
    expect(serialized).not.toContain('derivatives/');
    expect(serialized).not.toContain('http');
    expect(Object.keys(payload.results[0]!).sort()).toEqual([
      'checkedAt',
      'completionDate',
      'display',
      'id',
      'linkage',
      'original',
      'thumbnail',
      'title',
    ]);
  });

  it('reports a missing thumbnail only', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await insertAchievement({ title: 'Soft Morning', completionDate: '2026-06-02' });
    const keys = keysFor(id);
    await attachAsset(id, keys);
    await putObjects(memoryStorage(), keys, { thumbnail: false });

    const { response, payload } = await postHealth({ ids: [id] }, headers);

    expect(response.status).toBe(200);
    expect(payload.results[0]).toMatchObject({
      linkage: 'present',
      original: 'present',
      display: 'present',
      thumbnail: 'missing',
    });
  });

  it('shows absent asset linkage distinctly and skips storage probes', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await insertAchievement({ title: 'Unlinked Study', completionDate: '2026-06-01' });
    const metadata = vi.spyOn(memoryStorage(), 'getObjectMetadata');

    const { response, payload } = await postHealth({ ids: [id] }, headers);

    expect(response.status).toBe(200);
    expect(payload.results[0]).toMatchObject({
      id,
      linkage: 'missing',
      original: 'missing',
      display: 'missing',
      thumbnail: 'missing',
    });
    expect(metadata).not.toHaveBeenCalled();
  });

  it('maps a provider outage to unknown for every object without failing the batch', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const first = await insertAchievement({ title: 'Outage One', completionDate: '2026-06-04' });
    const second = await insertAchievement({ title: 'Outage Two', completionDate: '2026-06-05' });
    await attachAsset(first);
    await attachAsset(second);

    vi.spyOn(memoryStorage(), 'getObjectMetadata').mockRejectedValue(
      new StorageError('PROVIDER_OUTAGE', 'Provider unavailable', 503)
    );

    const { response, payload } = await postHealth({ ids: [first, second] }, headers);

    expect(response.status).toBe(200);
    expect(payload.results).toHaveLength(2);
    for (const result of payload.results) {
      expect(result).toMatchObject({
        linkage: 'present',
        original: 'unknown',
        display: 'unknown',
        thumbnail: 'unknown',
      });
    }
  });

  it('keeps intact objects when a single probe fails', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await insertAchievement({ title: 'Partial Failure', completionDate: '2026-06-06' });
    const keys = keysFor(id);
    await attachAsset(id, keys);
    await putObjects(memoryStorage(), keys);

    const originalMetadata = memoryStorage().getObjectMetadata.bind(memoryStorage());
    vi.spyOn(memoryStorage(), 'getObjectMetadata').mockImplementation(async (key: string) => {
      if (key === keys.original) {
        throw new StorageError('THROTTLED', 'Too many requests', 429);
      }
      return originalMetadata(key);
    });

    const { payload } = await postHealth({ ids: [id] }, headers);

    expect(payload.results[0]).toMatchObject({
      original: 'unknown',
      display: 'present',
      thumbnail: 'present',
    });
  });

  it('requires a session and CSRF headers', async () => {
    const { headers } = await createAuthenticatedHeaders();

    const noSession = { ...headers };
    delete (noSession as Partial<typeof headers>).cookie;
    const unauthenticated = await postHealth({ ids: [crypto.randomUUID()] }, noSession);
    expect(unauthenticated.response.status).toBe(401);
    expect((unauthenticated.payload as unknown as { code: string }).code).toBe('UNAUTHENTICATED');
    expect(unauthenticated.response.headers.get('cache-control')).toContain('no-store');

    const noCsrf = { ...headers };
    delete (noCsrf as Partial<typeof headers>)['x-requested-with'];
    delete (noCsrf as Partial<typeof headers>).origin;
    const forbidden = await postHealth({ ids: [crypto.randomUUID()] }, noCsrf);
    expect(forbidden.response.status).toBe(403);
    expect((forbidden.payload as unknown as { code: string }).code).toBe('CSRF_FAILED');
    expect(forbidden.response.headers.get('cache-control')).toContain('no-store');
  });

  it('rejects malformed JSON, empty, oversized, duplicate, and non-UUID batches', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const valid = crypto.randomUUID();

    const malformed = await postHealth('{not-json', headers);
    expect(malformed.response.status).toBe(400);
    expect((malformed.payload as unknown as { code: string }).code).toBe('INVALID_INPUT');

    const batches: unknown[] = [
      { ids: [] },
      { ids: Array.from({ length: 9 }, () => crypto.randomUUID()) },
      { ids: [valid, valid] },
      { ids: ['not-a-uuid'] },
      { ids: [123] },
      {},
    ];

    for (const body of batches) {
      const { response, payload } = await postHealth(body, headers);
      expect(response.status).toBe(400);
      expect((payload as unknown as { code: string }).code).toBe('INVALID_IDS');
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
  });

  it('ignores caller-supplied keys and derives storage keys from the database', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const id = await insertAchievement({ title: 'Database Owned Keys', completionDate: '2026-06-07' });
    const keys = keysFor(id);
    await attachAsset(id, keys);
    await putObjects(memoryStorage(), keys);

    const { response, payload } = await postHealth(
      {
        ids: [id],
        keys: { original: 'https://evil.example/steal', display: 'evil', thumbnail: 'evil' },
        originalKey: 'https://evil.example/steal',
      },
      headers
    );

    expect(response.status).toBe(200);
    expect(payload.results[0]).toMatchObject({
      linkage: 'present',
      original: 'present',
      display: 'present',
      thumbnail: 'present',
    });
    expect(JSON.stringify(payload)).not.toContain('evil');
    expect(JSON.stringify(payload)).not.toContain('originals/');
  });

  it('preserves requested order and skips non-ready records', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const readyOne = await insertAchievement({
      title: 'Ready One',
      completionDate: '2026-06-08',
    });
    const pending = await insertAchievement({
      title: 'Pending',
      completionDate: '2026-06-09',
      state: 'pending',
    });
    const deleting = await insertAchievement({
      title: 'Deleting',
      completionDate: '2026-06-10',
      state: 'deleting',
    });
    const readyTwo = await insertAchievement({
      title: 'Ready Two',
      completionDate: '2026-06-11',
    });

    for (const id of [readyOne, readyTwo]) {
      const keys = keysFor(id);
      await attachAsset(id, keys);
      await putObjects(memoryStorage(), keys);
    }

    const { response, payload } = await postHealth(
      { ids: [pending, readyTwo, deleting, readyOne] },
      headers
    );

    expect(response.status).toBe(200);
    expect(payload.results.map((result) => result.title)).toEqual(['Ready Two', 'Ready One']);
  });

  it('accepts a full batch of eight unique IDs', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const ids: string[] = [];

    for (let index = 0; index < 8; index++) {
      const id = await insertAchievement({
        title: `Batch Study ${index + 1}`,
        completionDate: '2026-06-12',
      });
      const keys = keysFor(id);
      await attachAsset(id, keys);
      await putObjects(memoryStorage(), keys);
      ids.push(id);
    }

    const { response, payload } = await postHealth({ ids }, headers);

    expect(response.status).toBe(200);
    expect(payload.results).toHaveLength(8);
    expect(payload.results.map((result) => result.id)).toEqual(ids);
  });
});
