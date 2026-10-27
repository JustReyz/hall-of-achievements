import { type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { uploadIntents } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { reserveUploadQuota, QuotaError, MAX_ORIGINAL_BYTES } from '@/lib/storage/quota';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function POST(request: NextRequest) {
  const { auth, errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body', 400, 'INVALID_INPUT');
  }

  const { fileName, mimeType, fileSize } = body as Record<string, unknown>;

  if (typeof fileName !== 'string' || fileName.trim().length === 0 || fileName.length > 255) {
    return jsonError('File name must be between 1 and 255 characters', 400, 'INVALID_FILE_NAME');
  }

  if (typeof mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(mimeType)) {
    return jsonError(
      'Unsupported MIME type. Only image/jpeg, image/png, and image/webp are allowed.',
      400,
      'INVALID_FILE_FORMAT'
    );
  }

  if (typeof fileSize !== 'number' || !Number.isInteger(fileSize) || fileSize <= 0) {
    return jsonError('File size must be a positive integer', 400, 'INVALID_FILE_SIZE');
  }

  if (fileSize > MAX_ORIGINAL_BYTES) {
    return jsonError(
      `File size (${fileSize} bytes) exceeds the maximum allowed size of 10 MiB (${MAX_ORIGINAL_BYTES} bytes).`,
      400,
      'FILE_TOO_LARGE'
    );
  }

  try {
    const db = await getDb();
    const storage = getStorage();

    const intent = await reserveUploadQuota(db, {
      tokenHash: auth.tokenHash,
      fileName: fileName.trim(),
      mimeType,
      declaredSize: fileSize,
    });

    // Generate signed upload URL for quarantine path (valid for 2 hours provider capability)
    let signedUpload;
    try {
      signedUpload = await storage.createSignedUploadUrl(intent.quarantineKey, 2 * 60 * 60);
    } catch (signingError) {
      // Rollback intent reservation to prevent quota leak and slot starvation
      try {
        // No upload URL was ever issued, so no quarantine object exists to clean.
        await db
          .update(uploadIntents)
          .set({ status: 'cleaned', quarantineCleanedAt: new Date() })
          .where(eq(uploadIntents.id, intent.id));
      } catch (cleanupError) {
        console.error('[UPLOADS INTENT ROLLBACK FAILED]', cleanupError);
      }
      throw signingError;
    }

    return jsonResponse(
      {
        intentId: intent.id,
        uploadUrl: signedUpload.uploadUrl,
        quarantineKey: intent.quarantineKey,
        expiresAt: intent.expiresAt.toISOString(),
        reservedBytes: intent.reservedBytes,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    if (err instanceof QuotaError) {
      return jsonError(err.message, err.statusCode, err.code);
    }
    console.error('[UPLOADS INTENT ERROR]', err);
    return jsonError('Failed to create upload intent', 500, 'INTENT_CREATION_FAILED');
  }
}
