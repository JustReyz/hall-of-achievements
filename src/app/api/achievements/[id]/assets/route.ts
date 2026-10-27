import { type NextRequest } from 'next/server';
import { eq, and, desc } from 'drizzle-orm';
import {
  authenticateApiRequest,
  jsonError,
  jsonResponse,
  PRIVATE_CACHE_HEADERS,
} from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { StorageNotFoundError } from '@/lib/storage/adapter';
import { normalVisibilityConditions } from '@/lib/gallery/query';

const SIGNED_URL_LIFETIME_SECONDS = 60; // Strictly <= 60 seconds per PRD AC5
const MAX_INLINE_DISPLAY_BYTES = 4 * 1024 * 1024;

function isWebp(data: Buffer): boolean {
  return (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  );
}

function sanitizeFilename(title: string, mimeType: string): string {
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'webp';
  const cleanTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'artwork';
  return `${cleanTitle}.${ext}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const { id } = await params;
  if (!id) return jsonError('Missing achievement ID', 400, 'INVALID_INPUT');

  const url = new URL(request.url);
  const requestedType = url.searchParams.get('type');
  const delivery = url.searchParams.get('delivery');
  const isInlineDelivery = delivery === 'inline';
  const isDownload = url.searchParams.get('download') === 'true';

  if (isInlineDelivery) {
    if (requestedType !== 'display') {
      return jsonError(
        'Inline delivery is available only for display derivatives',
        400,
        'INVALID_INLINE_ASSET_REQUEST'
      );
    }

    if (
      url.searchParams.has('url') ||
      url.searchParams.has('key') ||
      url.searchParams.has('assetKey')
    ) {
      return jsonError(
        'Inline delivery uses the server-owned display key only',
        400,
        'INVALID_INLINE_ASSET_REQUEST'
      );
    }
  }

  try {
    const db = await getDb();
    const storage = getStorage();

    // 1. Verify achievement exists and is ready
    const achRows = await db
      .select({
        id: achievements.id,
        title: achievements.title,
        state: achievements.state,
      })
      .from(achievements)
      .where(and(eq(achievements.id, id), ...normalVisibilityConditions()));

    const achievement = achRows[0];
    if (!achievement) {
      return jsonError('Achievement not found or not ready', 404, 'NOT_FOUND');
    }

    // 2. Fetch linked asset
    const assetRows = await db
      .select()
      .from(assets)
      .where(eq(assets.achievementId, id))
      .orderBy(desc(assets.createdAt))
      .limit(1);

    const asset = assetRows[0];
    if (!asset) {
      return jsonError('Asset not found for achievement', 404, 'ASSET_NOT_FOUND');
    }

    if (isInlineDelivery) {
      try {
        const display = await storage.getObject(asset.displayKey);

        if (display.data.length > MAX_INLINE_DISPLAY_BYTES) {
          return jsonError(
            'Display derivative exceeds the 4 MiB inline limit',
            413,
            'DISPLAY_TOO_LARGE'
          );
        }

        if (!isWebp(display.data)) {
          return jsonError(
            'Display derivative is not a valid WebP image',
            502,
            'INVALID_DISPLAY_DERIVATIVE'
          );
        }

        const headers = new Headers(PRIVATE_CACHE_HEADERS);
        headers.set('Content-Type', 'image/webp');
        headers.set('Content-Length', String(display.data.length));
        headers.set('Content-Disposition', 'inline');
        headers.set('X-Content-Type-Options', 'nosniff');

        return new Response(new Uint8Array(display.data), { status: 200, headers });
      } catch (err) {
        if (err instanceof StorageNotFoundError) {
          return jsonError('Display derivative is missing', 404, 'DISPLAY_NOT_FOUND');
        }
        throw err;
      }
    }

    const downloadFilename = sanitizeFilename(achievement.title, asset.mimeType);

    // If a specific type was requested
    if (requestedType === 'original') {
      const signed = await storage.createSignedDownloadUrl(
        asset.originalKey,
        SIGNED_URL_LIFETIME_SECONDS,
        isDownload ? { downloadFilename } : undefined
      );
      return jsonResponse({
        url: signed.downloadUrl,
        expiresInSeconds: SIGNED_URL_LIFETIME_SECONDS,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
      });
    }

    if (requestedType === 'thumbnail') {
      const signed = await storage.createSignedDownloadUrl(
        asset.thumbnailKey,
        SIGNED_URL_LIFETIME_SECONDS
      );
      return jsonResponse({
        url: signed.downloadUrl,
        expiresInSeconds: SIGNED_URL_LIFETIME_SECONDS,
        mimeType: 'image/webp',
        width: asset.width,
        height: asset.height,
      });
    }

    if (requestedType === 'display') {
      const signed = await storage.createSignedDownloadUrl(
        asset.displayKey,
        SIGNED_URL_LIFETIME_SECONDS
      );
      return jsonResponse({
        url: signed.downloadUrl,
        expiresInSeconds: SIGNED_URL_LIFETIME_SECONDS,
        mimeType: 'image/webp',
        width: asset.width,
        height: asset.height,
      });
    }

    // Default: return all 3 signed URLs (display, thumb, and download original)
    const [displaySigned, thumbSigned, originalSigned] = await Promise.all([
      storage.createSignedDownloadUrl(asset.displayKey, SIGNED_URL_LIFETIME_SECONDS),
      storage.createSignedDownloadUrl(asset.thumbnailKey, SIGNED_URL_LIFETIME_SECONDS),
      storage.createSignedDownloadUrl(asset.originalKey, SIGNED_URL_LIFETIME_SECONDS, {
        downloadFilename,
      }),
    ]);

    return jsonResponse({
      displayUrl: displaySigned.downloadUrl,
      thumbUrl: thumbSigned.downloadUrl,
      originalDownloadUrl: originalSigned.downloadUrl,
      expiresAt: displaySigned.expiresAt.toISOString(),
      expiresInSeconds: SIGNED_URL_LIFETIME_SECONDS,
    });
  } catch (err) {
    console.error('[GET /api/achievements/:id/assets ERROR]', err);
    return jsonError('Failed to generate signed asset URLs', 500, 'STORAGE_SIGNING_FAILED');
  }
}
