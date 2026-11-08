import { type NextRequest, NextResponse } from 'next/server';
import { authenticateApiRequest, jsonError, PRIVATE_CACHE_HEADERS } from '@/lib/auth/api-guard';
import { verifyStorageCapability } from '@/lib/storage/capabilities';
import { getStorage } from '@/lib/storage';

export async function GET(request: NextRequest) {
  // 1. Enforce active owner session authentication
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const expiresStr = url.searchParams.get('expires');
  const signature = url.searchParams.get('sig');
  const filename = url.searchParams.get('download') ?? undefined;

  if (!key) {
    return jsonError('Missing key parameter', 400, 'INVALID_INPUT');
  }

  // 2. Enforce cryptographic capability verification
  const expires = expiresStr ? parseInt(expiresStr, 10) : NaN;
  const verification = verifyStorageCapability({
    action: 'read',
    key,
    expiresAt: expires,
    signature: signature || '',
    downloadFilename: filename,
  });

  if (!verification.valid) {
    return jsonError(
      verification.reason || 'Forbidden: Capability verification failed',
      403,
      'FORBIDDEN_CAPABILITY'
    );
  }

  const storage = getStorage();
  try {
    const obj = await storage.getObject(key);
    const headers = new Headers(PRIVATE_CACHE_HEADERS);
    headers.set('Content-Type', obj.metadata.mimeType || 'application/octet-stream');
    headers.set('Content-Length', String(obj.data.length));

    if (filename) {
      headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    }

    return new NextResponse(new Uint8Array(obj.data), {
      status: 200,
      headers,
    });
  } catch {
    return jsonError('Object not found', 404, 'NOT_FOUND');
  }
}
