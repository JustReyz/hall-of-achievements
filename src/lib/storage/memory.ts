import {
  StorageAdapter,
  StorageObjectMetadata,
  PutObjectOptions,
  SignedUploadUrlResult,
  SignedDownloadUrlResult,
  StorageError,
  StorageNotFoundError,
} from './adapter';

export class MemoryStorageAdapter implements StorageAdapter {
  readonly providerName = 'memory' as const;
  private objects = new Map<string, { data: Buffer; metadata: StorageObjectMetadata }>();

  async putObject(
    key: string,
    data: Buffer | Uint8Array,
    options: PutObjectOptions
  ): Promise<StorageObjectMetadata> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (!options.upsert && this.objects.has(key)) {
      throw new StorageError('KEY_ALREADY_EXISTS', `Object already exists at key: ${key}`, 409);
    }

    const metadata: StorageObjectMetadata = {
      key,
      size: buffer.length,
      mimeType: options.contentType,
      lastModified: new Date(),
    };

    this.objects.set(key, { data: buffer, metadata });
    return metadata;
  }

  async getObject(key: string): Promise<{ data: Buffer; metadata: StorageObjectMetadata }> {
    const entry = this.objects.get(key);
    if (!entry) {
      throw new StorageNotFoundError(key);
    }
    return { data: entry.data, metadata: entry.metadata };
  }

  async getObjectMetadata(key: string): Promise<StorageObjectMetadata> {
    const entry = this.objects.get(key);
    if (!entry) {
      throw new StorageNotFoundError(key);
    }
    return { ...entry.metadata };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
    }
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

  clear(): void {
    this.objects.clear();
  }

  hasObject(key: string): boolean {
    return this.objects.has(key);
  }

  getStoredCount(): number {
    return this.objects.size;
  }
}
