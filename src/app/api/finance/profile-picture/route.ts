import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { financeUsers } from '@/lib/db/schema';
import { financeErrorResponse, lockFinanceSession, requireFinanceUser } from '@/lib/finance/auth';

const MAX_INPUT = 2 * 1024 * 1024;

export async function PUT(request: NextRequest) {
  try {
    const user = await requireFinanceUser(request);
    const reader = request.body?.getReader();
    if (!reader) return jsonError('Image is required.', 400, 'INVALID_IMAGE');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INPUT) { await reader.cancel(); return jsonError('Image exceeds 2 MB.', 413, 'IMAGE_TOO_LARGE'); }
      chunks.push(value);
    }
    let image: Buffer;
    try {
      const input = Buffer.concat(chunks);
      const metadata = await sharp(input, { limitInputPixels: 20_000_000 }).metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image');
      image = await sharp(input, { limitInputPixels: 20_000_000 }).rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 75 }).toBuffer();
      if (image.length > 100_000) throw new Error('Image is too large');
    } catch {
      return jsonError('Invalid image. Use a JPEG, PNG, or WebP image.', 400, 'INVALID_IMAGE');
    }
    const picture = `data:image/webp;base64,${image.toString('base64')}`;
    const db = await getDb();
    await db.transaction(async (tx) => {
      await lockFinanceSession(tx, user);
      await tx.update(financeUsers).set({ profilePicture: picture, updatedAt: new Date() }).where(eq(financeUsers.id, user.userId));
      await lockFinanceSession(tx, user);
    });
    return jsonResponse({ profilePicture: picture });
  } catch (error) { return financeErrorResponse(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireFinanceUser(request);
    const db = await getDb();
    await db.transaction(async (tx) => {
      await lockFinanceSession(tx, user);
      await tx.update(financeUsers).set({ profilePicture: null, updatedAt: new Date() }).where(eq(financeUsers.id, user.userId));
      await lockFinanceSession(tx, user);
    });
    return jsonResponse({ profilePicture: null });
  } catch (error) { return financeErrorResponse(error); }
}
