export interface StorageObjectMetadata {
  key: string;
  size: number;
  mimeType: string;
  etag?: string;
  lastModified?: Date;
}

export interface PutObjectOptions {
  contentType: string;
  cacheControl?: string;
  upsert?: boolean;
}

export interface SignedUploadUrlResult {
  uploadUrl: string;
  key: string;
  expiresAt: Date;
}

export interface SignedDownloadUrlResult {
  downloadUrl: string;
  expiresAt: Date;
}

export interface StorageAdapter {
  readonly providerName: 'memory' | 'supabase';

  putObject(
    key: string,
    data: Buffer | Uint8Array,
    options: PutObjectOptions
  ): Promise<StorageObjectMetadata>;

  getObject(key: string): Promise<{
    data: Buffer;
    metadata: StorageObjectMetadata;
  }>;

  deleteObject(key: string): Promise<void>;

  deleteObjects(keys: string[]): Promise<void>;

  createSignedUploadUrl(
    key: string,
    expiresInSeconds: number
  ): Promise<SignedUploadUrlResult>;

  createSignedDownloadUrl(
    key: string,
    expiresInSeconds: number,
    options?: { downloadFilename?: string; contentType?: string }
  ): Promise<SignedDownloadUrlResult>;
}

export class StorageError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number = 500) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class StorageNotFoundError extends StorageError {
  constructor(key: string) {
    super('NOT_FOUND', `Object not found at key: ${key}`, 404);
  }
}
