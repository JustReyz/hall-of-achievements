import { Pool } from '@neondatabase/serverless';
import {
  StorageAdapter,
  StorageObjectMetadata,
  PutObjectOptions,
  SignedUploadUrlResult,
  SignedDownloadUrlResult,
  StorageError,
  StorageNotFoundError,
} from './adapter';
import { env } from '../env';

export class PostgresStorageAdapter implements StorageAdapter {
  readonly providerName = 'postgres' as const;
  private pool: Pool | null = null;

  constructor(private connectionString: string = env.DATABASE_URL) {}

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: 10,
        connectionTimeoutMillis: 5000,
      });
    }
    return this.pool;
  }

  async putObject(
    key: string,
    data: Buffer | Uint8Array,
    options: PutObjectOptions
  ): Promise<StorageObjectMetadata> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const pool = this.getPool();

    if (!options.upsert) {
      const checkRes = await pool.query('SELECT 1 FROM storage_objects WHERE key = $1', [key]);
      if ((checkRes.rowCount ?? 0) > 0) {
        throw new StorageError('KEY_ALREADY_EXISTS', `Object already exists at key: ${key}`, 409);
      }
    }

    const query = `
      INSERT INTO storage_objects (key, data, mime_type, size, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (key) DO UPDATE
      SET data = EXCLUDED.data,
          mime_type = EXCLUDED.mime_type,
          size = EXCLUDED.size,
          updated_at = NOW()
      RETURNING updated_at;
    `;

    const res = await pool.query(query, [key, buffer, options.contentType, buffer.length]);
    const updatedAt = (res.rows[0]?.updated_at as Date) || new Date();

    return {
      key,
      size: buffer.length,
      mimeType: options.contentType,
      lastModified: updatedAt,
    };
  }

  async getObject(key: string): Promise<{ data: Buffer; metadata: StorageObjectMetadata }> {
    const pool = this.getPool();
    const res = await pool.query(
      'SELECT data, mime_type, size, updated_at FROM storage_objects WHERE key = $1',
      [key]
    );

    const row = res.rows[0];
    if (!row) {
      throw new StorageNotFoundError(key);
    }

    const dataBuffer = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    return {
      data: dataBuffer,
      metadata: {
        key,
        size: row.size,
        mimeType: row.mime_type,
        lastModified: row.updated_at ? new Date(row.updated_at) : new Date(),
      },
    };
  }

  async getObjectMetadata(key: string): Promise<StorageObjectMetadata> {
    const pool = this.getPool();
    // Metadata probe: never select or transfer the stored bytes.
    const res = await pool.query(
      'SELECT mime_type, size, updated_at FROM storage_objects WHERE key = $1',
      [key]
    );

    const row = res.rows[0];
    if (!row) {
      throw new StorageNotFoundError(key);
    }

    return {
      key,
      size: row.size,
      mimeType: row.mime_type,
      lastModified: row.updated_at ? new Date(row.updated_at) : new Date(),
    };
  }

  async deleteObject(key: string): Promise<void> {
    const pool = this.getPool();
    await pool.query('DELETE FROM storage_objects WHERE key = $1', [key]);
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const pool = this.getPool();
    await pool.query('DELETE FROM storage_objects WHERE key = ANY($1)', [keys]);
  }

  async createSignedUploadUrl(
    key: string,
    expiresInSeconds: number
  ): Promise<SignedUploadUrlResult> {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    return {
      uploadUrl: `/api/mock-storage/upload?key=${encodeURIComponent(key)}&expires=${expiresAt.getTime()}`,
      key,
      expiresAt,
    };
  }

  async createSignedDownloadUrl(
    key: string,
    expiresInSeconds: number,
    options?: { downloadFilename?: string; contentType?: string }
  ): Promise<SignedDownloadUrlResult> {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const query = new URLSearchParams({
      key,
      expires: expiresAt.getTime().toString(),
    });
    if (options?.downloadFilename) {
      query.set('download', options.downloadFilename);
    }
    return {
      downloadUrl: `/api/mock-storage/download?${query.toString()}`,
      expiresAt,
    };
  }
}
