import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { verifyStorageCapability } from '@/lib/storage/capabilities';
import { getStorage } from '@/lib/storage';

export async function PUT(request: NextRequest) {
  // 1. Enforce active owner session authentication (CSRF bypassed for signed capability PUT)
  const { errorResponse } = await authenticateApiRequest(request, { checkCsrf: false });
  if (errorResponse) return errorResponse;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const expiresStr = url.searchParams.get('expires');
  const signature = url.searchParams.get('sig');

  if (!key) {
    return jsonError('Missing key parameter', 400, 'INVALID_INPUT');
  }

  // 2. Strict boundary: upload capability only allowed on quarantine paths
  if (!key.startsWith('quarantine/') || key.includes('..')) {
    return jsonError('Upload capability restricted to quarantine path', 403, 'FORBIDDEN_KEY');
  }

  // 3. Enforce cryptographic capability verification
  const expires = expiresStr ? parseInt(expiresStr, 10) : NaN;
  const verification = verifyStorageCapability({
    action: 'write',
    key,
    expiresAt: expires,
    signature: signature || '',
  });

  if (!verification.valid) {
    return jsonError(
      verification.reason || 'Forbidden: Capability verification failed',
      403,
      'FORBIDDEN_CAPABILITY'
    );
  }

  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await request.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const storage = getStorage();
  await storage.putObject(key, buffer, { contentType, upsert: true });

  return jsonResponse({ success: true, key, size: buffer.length });
}
