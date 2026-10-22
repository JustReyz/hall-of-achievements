import { describe, it, expect, vi } from 'vitest';
import { PostgresStorageAdapter } from '@/lib/storage/postgres';
import { StorageError, StorageNotFoundError } from '@/lib/storage/adapter';

describe('Unit: PostgresStorageAdapter', () => {
  it('instantiates cleanly with default or custom connection string', () => {
    const adapter = new PostgresStorageAdapter('postgresql://localhost:5432/test');
    expect(adapter.providerName).toBe('postgres');
  });

  it('generates signed upload and download capability URLs', async () => {
    const adapter = new PostgresStorageAdapter('postgresql://localhost:5432/test');

    const upload = await adapter.createSignedUploadUrl('quarantine/test-key.jpg', 60);
    expect(upload.key).toBe('quarantine/test-key.jpg');
    expect(upload.uploadUrl).toContain('/api/mock-storage/upload?key=quarantine%2Ftest-key.jpg');
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const download = await adapter.createSignedDownloadUrl('assets/art.webp', 60, {
      downloadFilename: 'my-art.webp',
    });
    expect(download.downloadUrl).toContain('/api/mock-storage/download');
    expect(download.downloadUrl).toContain('key=assets%2Fart.webp');
    expect(download.downloadUrl).toContain('download=my-art.webp');
    expect(download.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('executes putObject, getObject, deleteObject, and deleteObjects against postgres pool', async () => {
    const adapter = new PostgresStorageAdapter('postgresql://localhost:5432/test');

    const mockPool = {
      query: vi.fn(),
    };
    (adapter as unknown as { pool: unknown }).pool = mockPool;

    // Test putObject without upsert (key already exists check)
    mockPool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT 1 check
      .mockResolvedValueOnce({ rows: [{ updated_at: new Date('2026-10-22T12:00:00Z') }] }); // INSERT

    const putRes = await adapter.putObject('test.png', Buffer.from('image-data'), {
      contentType: 'image/png',
      upsert: false,
    });
    expect(putRes.key).toBe('test.png');
    expect(putRes.size).toBe(10);
    expect(putRes.mimeType).toBe('image/png');

    // Test putObject duplicate key error
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });
    await expect(
      adapter.putObject('test.png', Buffer.from('data'), {
        contentType: 'image/png',
        upsert: false,
      })
    ).rejects.toThrow(StorageError);

    // Test getObject success
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          data: Buffer.from('stored-image-bytes'),
          mime_type: 'image/webp',
          size: 18,
          updated_at: new Date('2026-10-22T12:00:00Z'),
        },
      ],
    });
    const getRes = await adapter.getObject('test.png');
    expect(getRes.data.toString()).toBe('stored-image-bytes');
    expect(getRes.metadata.mimeType).toBe('image/webp');
    expect(getRes.metadata.size).toBe(18);

    // Test getObject not found
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(adapter.getObject('missing.png')).rejects.toThrow(StorageNotFoundError);

    // Test deleteObject
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
    await adapter.deleteObject('test.png');
    expect(mockPool.query).toHaveBeenCalledWith('DELETE FROM storage_objects WHERE key = $1', ['test.png']);

    // Test deleteObjects
    mockPool.query.mockResolvedValueOnce({ rowCount: 2 });
    await adapter.deleteObjects(['k1', 'k2']);
    expect(mockPool.query).toHaveBeenCalledWith('DELETE FROM storage_objects WHERE key = ANY($1)', [['k1', 'k2']]);
  });
});
