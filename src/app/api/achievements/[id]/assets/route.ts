import { type NextRequest } from 'next/server';
import { eq, and, desc } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';

const SIGNED_URL_LIFETIME_SECONDS = 60; // Strictly <= 60 seconds per PRD AC5

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
  const isDownload = url.searchParams.get('download') === 'true';

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
      .where(and(eq(achievements.id, id), eq(achievements.state, 'ready')));

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
