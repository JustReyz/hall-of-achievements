import {
  StorageAdapter,
  StorageObjectMetadata,
  PutObjectOptions,
  SignedUploadUrlResult,
  SignedDownloadUrlResult,
  StorageError,
  StorageNotFoundError,
} from './adapter';

export interface SupabaseStorageConfig {
  url: string;
  serviceRoleKey: string;
  bucket?: string;
}

export class SupabaseStorageAdapter implements StorageAdapter {
  readonly providerName = 'supabase' as const;
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly bucket: string;

  constructor(config: SupabaseStorageConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.serviceRoleKey = config.serviceRoleKey;
    this.bucket = config.bucket || 'achievements-private';
  }

  private getHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
    };
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return headers;
  }

  async putObject(
    key: string,
    data: Buffer | Uint8Array,
    options: PutObjectOptions
  ): Promise<StorageObjectMetadata> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const cleanKey = key.replace(/^\/+/, '');
    const url = `${this.baseUrl}/storage/v1/object/${this.bucket}/${cleanKey}`;

    const headers = this.getHeaders(options.contentType);
    headers['x-upsert'] = options.upsert ? 'true' : 'false';
    if (options.cacheControl) {
      headers['cache-control'] = options.cacheControl;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: new Uint8Array(buffer),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 409 || errText.includes('already exists')) {
        throw new StorageError('KEY_ALREADY_EXISTS', `Object already exists at key: ${key}`, 409);
      }
      throw new StorageError('PUT_FAILED', `Supabase putObject failed (${res.status}): ${errText}`, res.status);
    }

    return {
      key: cleanKey,
      size: buffer.length,
      mimeType: options.contentType,
      lastModified: new Date(),
    };
  }

  async getObject(key: string): Promise<{ data: Buffer; metadata: StorageObjectMetadata }> {
    const cleanKey = key.replace(/^\/+/, '');
    const url = `${this.baseUrl}/storage/v1/object/authenticated/${this.bucket}/${cleanKey}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (res.status === 404) {
      throw new StorageNotFoundError(cleanKey);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new StorageError('GET_FAILED', `Supabase getObject failed (${res.status}): ${errText}`, res.status);
    }

    const arrayBuf = await res.arrayBuffer();
    const data = Buffer.from(arrayBuf);
    const contentType = res.headers.get('content-type') || 'application/octet-stream';

    return {
      data,
      metadata: {
        key: cleanKey,
        size: data.length,
        mimeType: contentType,
        lastModified: new Date(),
      },
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.deleteObjects([key]);
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const cleanKeys = keys.map((k) => k.replace(/^\/+/, ''));
    const url = `${this.baseUrl}/storage/v1/object/${this.bucket}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.getHeaders('application/json'),
      body: JSON.stringify({ prefixes: cleanKeys }),
    });

    // Storage deletions are idempotent: ignore 404 / non-blocking errors
    if (!res.ok && res.status !== 404) {
      const errText = await res.text();
      throw new StorageError('DELETE_FAILED', `Supabase deleteObjects failed (${res.status}): ${errText}`, res.status);
    }
  }

  async createSignedUploadUrl(
    key: string,
    expiresInSeconds: number
  ): Promise<SignedUploadUrlResult> {
    const cleanKey = key.replace(/^\/+/, '');
    const url = `${this.baseUrl}/storage/v1/object/upload/sign/${this.bucket}/${cleanKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders('application/json'),
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new StorageError('SIGN_UPLOAD_FAILED', `Supabase sign upload URL failed (${res.status}): ${errText}`, res.status);
    }

    const json = (await res.json()) as { url?: string };
    const uploadPath = json.url || '';
    const fullUploadUrl = uploadPath.startsWith('http')
      ? uploadPath
      : `${this.baseUrl}/storage/v1${uploadPath.startsWith('/') ? '' : '/'}${uploadPath}`;

    return {
      uploadUrl: fullUploadUrl,
      key: cleanKey,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async createSignedDownloadUrl(
    key: string,
    expiresInSeconds: number,
    options?: { downloadFilename?: string; contentType?: string }
  ): Promise<SignedDownloadUrlResult> {
    const cleanKey = key.replace(/^\/+/, '');
    const url = `${this.baseUrl}/storage/v1/object/sign/${this.bucket}/${cleanKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders('application/json'),
      body: JSON.stringify({
        expiresIn: expiresInSeconds,
        ...(options?.downloadFilename ? { download: options.downloadFilename } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new StorageError('SIGN_DOWNLOAD_FAILED', `Supabase sign download URL failed (${res.status}): ${errText}`, res.status);
    }

    const json = (await res.json()) as { signedURL?: string; url?: string };
    const signedPath = json.signedURL || json.url || '';
    let fullUrl = signedPath.startsWith('http')
      ? signedPath
      : `${this.baseUrl}/storage/v1${signedPath.startsWith('/') ? '' : '/'}${signedPath}`;

    if (options?.downloadFilename && !fullUrl.includes('download=')) {
      const separator = fullUrl.includes('?') ? '&' : '?';
      fullUrl += `${separator}download=${encodeURIComponent(options.downloadFilename)}`;
    }

    return {
      downloadUrl: fullUrl,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }
}
