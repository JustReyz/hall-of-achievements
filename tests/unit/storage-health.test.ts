import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  StorageAdapter,
  StorageError,
  StorageNotFoundError,
  StorageObjectMetadata,
} from '@/lib/storage/adapter';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { PostgresStorageAdapter } from '@/lib/storage/postgres';
import { SupabaseStorageAdapter } from '@/lib/storage/supabase';
import {
  HealthRecord,
  inspectHealthRecords,
  validateHealthIds,
} from '@/lib/storage/health';
import { ValidationError } from '@/lib/validation/achievement';

function createRecord(keys?: HealthRecord['keys']): HealthRecord {
  return {
    id: crypto.randomUUID(),
    title: 'Harbor Study',
    completionDate: '2026-06-03',
    keys:
      keys === undefined
        ? {
            original: 'originals/harbor/original.jpg',
            display: 'derivatives/harbor/display.webp',
            thumbnail: 'derivatives/harbor/thumb.webp',
          }
        : keys,
  };
}

function createProbeStorage(handler: (key: string) => Promise<StorageObjectMetadata>) {
  const getObject = vi.fn(async () => {
    throw new Error('getObject must never be called while inspecting health');
  });
  const getObjectMetadata = vi.fn(handler);

  const adapter: StorageAdapter = {
    providerName: 'memory',
    putObject: async () => {
      throw new Error('putObject is not used by health checks');
    },
    getObject,
    getObjectMetadata,
    deleteObject: async () => {
      throw new Error('deleteObject is not used by health checks');
    },
    deleteObjects: async () => {
      throw new Error('deleteObjects is not used by health checks');
    },
    createSignedUploadUrl: async () => {
      throw new Error('createSignedUploadUrl is not used by health checks');
    },
    createSignedDownloadUrl: async () => {
      throw new Error('createSignedDownloadUrl is not used by health checks');
    },
  };

  return { adapter, getObject, getObjectMetadata };
}

function metadataFor(key: string): StorageObjectMetadata {
  return {
    key,
    size: 1024,
    mimeType: key.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
    lastModified: new Date('2026-10-20T10:00:00Z'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Unit: archive health inspection', () => {
  describe('validateHealthIds', () => {
    it('accepts 1 through 8 unique UUIDs and normalizes case and whitespace', () => {
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();

      expect(validateHealthIds([` ${first.toUpperCase()} `, second])).toEqual([first, second]);
      expect(validateHealthIds([first])).toHaveLength(1);
      expect(validateHealthIds(Array.from({ length: 8 }, () => crypto.randomUUID()))).toHaveLength(8);
    });

    it('rejects non-arrays, empty batches, oversized batches, duplicates, non-strings, and invalid UUIDs', () => {
      const first = crypto.randomUUID();

      expect(() => validateHealthIds(undefined)).toThrow(ValidationError);
      expect(() => validateHealthIds('not-an-array')).toThrow(ValidationError);
      expect(() => validateHealthIds([])).toThrow(ValidationError);
      expect(() =>
        validateHealthIds(Array.from({ length: 9 }, () => crypto.randomUUID()))
      ).toThrow(ValidationError);
      expect(() => validateHealthIds([first, first.toUpperCase()])).toThrow(ValidationError);
      expect(() => validateHealthIds([123])).toThrow(ValidationError);
      expect(() => validateHealthIds(['not-a-uuid'])).toThrow(ValidationError);

      try {
        validateHealthIds([]);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).code).toBe('INVALID_IDS');
        expect((error as ValidationError).statusCode).toBe(400);
      }
    });
  });

  it('reports a missing original while intact derivatives remain present', async () => {
    const record = createRecord();
    const { adapter, getObject, getObjectMetadata } = createProbeStorage(async (key) => {
      if (key === record.keys!.original) throw new StorageNotFoundError(key);
      return metadataFor(key);
    });

    const [result] = await inspectHealthRecords([record], adapter);

    expect(result).toMatchObject({
      id: record.id,
      title: 'Harbor Study',
      completionDate: '2026-06-03',
      linkage: 'present',
      original: 'missing',
      display: 'present',
      thumbnail: 'present',
    });
    expect(getObjectMetadata).toHaveBeenCalledTimes(3);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('reports a missing thumbnail only', async () => {
    const record = createRecord();
    const { adapter, getObjectMetadata } = createProbeStorage(async (key) => {
      if (key === record.keys!.thumbnail) throw new StorageNotFoundError(key);
      return metadataFor(key);
    });

    const results = await inspectHealthRecords([record], adapter);
    const result = results[0]!;

    expect(result.original).toBe('present');
    expect(result.display).toBe('present');
    expect(result.thumbnail).toBe('missing');
    expect(result.linkage).toBe('present');
    expect(getObjectMetadata).toHaveBeenCalledTimes(3);
  });

  it('reports absent asset linkage distinctly and does not probe storage', async () => {
    const record = createRecord(null);
    const { adapter, getObjectMetadata } = createProbeStorage(async (key) => metadataFor(key));

    const results = await inspectHealthRecords([record], adapter);
    const result = results[0]!;

    expect(result).toMatchObject({
      linkage: 'missing',
      original: 'missing',
      display: 'missing',
      thumbnail: 'missing',
    });
    expect(getObjectMetadata).not.toHaveBeenCalled();
  });

  it('maps a provider outage to unknown without failing the batch', async () => {
    const records = [createRecord(), createRecord()];
    const { adapter, getObject } = createProbeStorage(async () => {
      throw new StorageError('PROVIDER_OUTAGE', 'Storage provider unavailable', 503);
    });

    const results = await inspectHealthRecords(records, adapter);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({
        linkage: 'present',
        original: 'unknown',
        display: 'unknown',
        thumbnail: 'unknown',
      });
    }
    expect(getObject).not.toHaveBeenCalled();
  });

  it('only treats a typed StorageNotFoundError as missing', async () => {
    const record = createRecord();
    const { adapter } = createProbeStorage(async (key) => {
      if (key === record.keys!.original) {
        throw new Error('Object not found (text error, not typed)');
      }
      if (key === record.keys!.display) {
        throw new StorageError('THROTTLED', 'Too many requests', 429);
      }
      return metadataFor(key);
    });

    const results = await inspectHealthRecords([record], adapter);
    const result = results[0]!;

    expect(result.original).toBe('unknown');
    expect(result.display).toBe('unknown');
    expect(result.thumbnail).toBe('present');
  });

  it('times out a stalled probe and keeps the rest of the batch', async () => {
    const record = createRecord();
    const { adapter } = createProbeStorage(async (key) => {
      if (key === record.keys!.original) {
        return await new Promise<StorageObjectMetadata>(() => {});
      }
      return metadataFor(key);
    });

    const started = Date.now();
    const results = await inspectHealthRecords([record], adapter, {
      timeoutMs: 30,
      deadlineMs: 500,
    });
    const elapsed = Date.now() - started;
    const result = results[0]!;

    expect(result.original).toBe('unknown');
    expect(result.display).toBe('present');
    expect(result.thumbnail).toBe('present');
    expect(elapsed).toBeLessThan(1000);
  });

  it('never runs more than three provider probes at once', async () => {
    const records = [createRecord(), createRecord(), createRecord(), createRecord()];
    let active = 0;
    let maxActive = 0;

    const { adapter } = createProbeStorage(async (key) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return metadataFor(key);
    });

    await inspectHealthRecords(records, adapter, { concurrency: 99 });

    expect(maxActive).toBe(3);
  });

  it('keeps timed-out provider calls counted against the three-request bound', async () => {
    const records = Array.from({ length: 4 }, () => createRecord());
    let active = 0;
    let maxActive = 0;
    const settle: Array<() => void> = [];

    const { adapter } = createProbeStorage(
      (key: string) =>
        new Promise<StorageObjectMetadata>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          settle.push(() => {
            active--;
            resolve(metadataFor(key));
          });
        })
    );

    const started = Date.now();
    const results = await inspectHealthRecords(records, adapter, {
      timeoutMs: 20,
      deadlineMs: 120,
    });
    const elapsed = Date.now() - started;

    // The three calls that were dispatched are still running, so the gate must not
    // let a fourth start just because the batch stopped awaiting them.
    expect(maxActive).toBe(3);
    expect(settle).toHaveLength(3);
    expect(elapsed).toBeLessThan(1000);
    for (const result of results) {
      expect(result.original).toBe('unknown');
      expect(result.display).toBe('unknown');
      expect(result.thumbnail).toBe('unknown');
    }

    for (const release of settle) release();
  });

  it('caps a whole batch at the deadline and marks remaining probes unknown', async () => {
    const records = [createRecord(), createRecord(), createRecord(), createRecord()];
    const { adapter } = createProbeStorage(async (key) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return metadataFor(key);
    });

    const started = Date.now();
    const results = await inspectHealthRecords(records, adapter, {
      timeoutMs: 3000,
      deadlineMs: 20,
    });
    const elapsed = Date.now() - started;

    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.original).toBe('unknown');
      expect(result.display).toBe('unknown');
      expect(result.thumbnail).toBe('unknown');
    }
    expect(elapsed).toBeLessThan(1000);
  });

  it('returns only public health fields, without storage keys or URLs', async () => {
    const record = createRecord();
    const { adapter } = createProbeStorage(async (key) => metadataFor(key));

    const results = await inspectHealthRecords([record], adapter);
    const result = results[0]!;

    expect(Object.keys(result).sort()).toEqual([
      'checkedAt',
      'completionDate',
      'display',
      'id',
      'linkage',
      'original',
      'thumbnail',
      'title',
    ]);
    expect(JSON.stringify(result)).not.toContain('originals/');
    expect(JSON.stringify(result)).not.toContain('derivatives/');
    expect(JSON.stringify(result)).not.toContain('http');
  });

  it('uses one checkedAt timestamp for every result in the batch', async () => {
    const fixed = new Date('2026-10-27T12:34:56.000Z');
    const records = [createRecord(), createRecord()];
    const { adapter } = createProbeStorage(async (key) => metadataFor(key));

    const results = await inspectHealthRecords(records, adapter, {
      now: () => fixed,
    });

    expect(results[0]?.checkedAt).toBe(fixed.toISOString());
    expect(results[1]?.checkedAt).toBe(fixed.toISOString());
  });
});

describe('Unit: storage adapters expose metadata without reading bytes', () => {
  it('MemoryStorageAdapter reads only metadata and throws typed not-found', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('derivatives/memory/display.webp', Buffer.from('webp-bytes'), {
      contentType: 'image/webp',
    });

    const getObject = vi.spyOn(adapter, 'getObject');
    const metadata = await adapter.getObjectMetadata('derivatives/memory/display.webp');

    expect(metadata).toMatchObject({
      key: 'derivatives/memory/display.webp',
      size: 10,
      mimeType: 'image/webp',
    });
    expect(getObject).not.toHaveBeenCalled();
    await expect(adapter.getObjectMetadata('missing/key.webp')).rejects.toBeInstanceOf(
      StorageNotFoundError
    );
  });

  it('PostgresStorageAdapter selects metadata columns and never the bytes column', async () => {
    const adapter = new PostgresStorageAdapter('postgresql://localhost:5432/test');
    const updatedAt = new Date('2026-10-21T08:00:00.000Z');
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ mime_type: 'image/webp', size: 4096, updated_at: updatedAt }],
      })
      .mockResolvedValueOnce({ rows: [] });

    (adapter as unknown as { pool: unknown }).pool = { query };

    const metadata = await adapter.getObjectMetadata('derivatives/pg/thumb.webp');

    expect(metadata).toEqual({
      key: 'derivatives/pg/thumb.webp',
      size: 4096,
      mimeType: 'image/webp',
      lastModified: updatedAt,
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('mime_type');
    expect(sql).toContain('size');
    expect(sql).toContain('updated_at');
    expect(sql).not.toMatch(/\bdata\b/);
    expect(query.mock.calls[0]?.[1]).toEqual(['derivatives/pg/thumb.webp']);

    await expect(adapter.getObjectMetadata('derivatives/pg/missing.webp')).rejects.toBeInstanceOf(
      StorageNotFoundError
    );
  });

  it('SupabaseStorageAdapter uses an authenticated HEAD request', async () => {
    const adapter = new SupabaseStorageAdapter({
      url: 'https://example.supabase.co/',
      serviceRoleKey: 'service-role-test-key',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          'content-length': '2048',
          'content-type': 'image/webp',
          etag: '"etag-value"',
          'last-modified': 'Tue, 20 Oct 2026 10:00:00 GMT',
        },
      })
    );

    const metadata = await adapter.getObjectMetadata('/derivatives/sb/display.webp');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      'https://example.supabase.co/storage/v1/object/authenticated/achievements-private/derivatives/sb/display.webp'
    );
    expect(init?.method).toBe('HEAD');
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer service-role-test-key'
    );
    expect(metadata).toMatchObject({
      key: 'derivatives/sb/display.webp',
      size: 2048,
      mimeType: 'image/webp',
      etag: '"etag-value"',
    });
  });

  it('SupabaseStorageAdapter maps a 404 to typed not-found and other failures to unknown-worthy errors', async () => {
    const adapter = new SupabaseStorageAdapter({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-test-key',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(adapter.getObjectMetadata('derivatives/sb/missing.webp')).rejects.toBeInstanceOf(
      StorageNotFoundError
    );

    fetchSpy.mockResolvedValueOnce(new Response('provider unavailable', { status: 503 }));
    const failure = await adapter
      .getObjectMetadata('derivatives/sb/display.webp')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).not.toBeInstanceOf(StorageNotFoundError);
    expect(failure).toMatchObject({ code: 'METADATA_FAILED', statusCode: 503 });
  });
});
