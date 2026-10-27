import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import {
  MAX_DERIVATIVE_BOUND_BYTES,
  MAX_ORIGINAL_BYTES,
  RESERVED_BYTES_PER_INTENT,
} from '@/lib/storage/quota';
import { POST as intentHandler } from '@/app/api/uploads/intents/route';
import { POST as finalizeHandler } from '@/app/api/uploads/[id]/finalize/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestJpeg } from '../helpers/image-fixtures';
import type { ValidationSuccess } from '@/lib/image/types';

const limits = {
  byteLength: 1024 * 1024,
  displayBytes: 1024,
  thumbnailBytes: 512,
};

vi.mock('@/lib/image/validator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/image/validator')>();
  return {
    ...actual,
    validateImageBuffer: async (): Promise<ValidationSuccess> => ({
      valid: true,
      mimeType: 'image/jpeg',
      byteLength: limits.byteLength,
      width: 800,
      height: 600,
      checksum: 'a'.repeat(64),
    }),
  };
});

vi.mock('@/lib/image/processor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/image/processor')>();
  return {
    ...actual,
    processImageDerivatives: async () => ({
      displayBuffer: Buffer.alloc(limits.displayBytes),
      displayWidth: 800,
      displayHeight: 600,
      displayBytes: limits.displayBytes,
      thumbnailBuffer: Buffer.alloc(limits.thumbnailBytes),
      thumbnailWidth: 400,
      thumbnailHeight: 300,
      thumbnailBytes: limits.thumbnailBytes,
    }),
  };
});

const BASE = 'http://localhost:3000';

async function startUpload(headers: Record<string, string>): Promise<{
  intentId: string;
  quarantineKey: string;
}> {
  const jpeg = await createTestJpeg(240, 180);
  const response = await intentHandler(
    new NextRequest(`${BASE}/api/uploads/intents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fileName: 'limits.jpg', mimeType: 'image/jpeg', fileSize: jpeg.length }),
    })
  );
  const payload = (await response.json()) as { intentId: string; quarantineKey: string };
  const storage = getStorage() as MemoryStorageAdapter;
  await storage.putObject(payload.quarantineKey, jpeg, { contentType: 'image/jpeg' });
  return payload;
}

async function finalize(headers: Record<string, string>, intentId: string) {
  const response = await finalizeHandler(
    new NextRequest(`${BASE}/api/uploads/${intentId}/finalize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Boundary Piece' }),
    }),
    { params: Promise.resolve({ id: intentId }) }
  );
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  limits.byteLength = 1024 * 1024;
  limits.displayBytes = 1024;
  limits.thumbnailBytes = 512;
  await resetDatabase();
  (getStorage() as MemoryStorageAdapter).clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Integration: upload staging envelope', () => {
  it('rejects a derivative beyond the per-artwork derivative bound before binding', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { intentId } = await startUpload(headers);

    limits.displayBytes = MAX_DERIVATIVE_BOUND_BYTES + 1;
    const result = await finalize(headers, intentId);

    expect(result.status).toBe(413);
    expect(result.payload.code).toBe('DERIVATIVE_TOO_LARGE');

    const db = await getDb();
    expect(await db.select().from(achievements)).toHaveLength(0);
    expect(await db.select().from(assets)).toHaveLength(0);

    const [intent] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId));
    expect(intent?.status).toBe('pending');
    expect(intent?.permanentKeys).toEqual([]);
  });

  it('rejects a staged size above the intent reservation before any permanent write', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { intentId, quarantineKey } = await startUpload(headers);

    const halfDerivative = Math.floor(MAX_DERIVATIVE_BOUND_BYTES / 2);
    limits.byteLength = MAX_ORIGINAL_BYTES;
    limits.displayBytes = halfDerivative + 1;
    limits.thumbnailBytes = halfDerivative + 1;

    const result = await finalize(headers, intentId);

    expect(result.status).toBe(413);
    expect(result.payload.code).toBe('RESERVATION_EXCEEDED');

    const db = await getDb();
    expect(await db.select().from(achievements)).toHaveLength(0);
    expect(await db.select().from(assets)).toHaveLength(0);
    expect((getStorage() as MemoryStorageAdapter).hasObject(quarantineKey)).toBe(true);

    const [intent] = await db
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, intentId));
    expect(intent?.permanentKeys).toEqual([]);
  });

  it('accepts a staged size exactly at the reservation boundary', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const { intentId } = await startUpload(headers);

    limits.byteLength = RESERVED_BYTES_PER_INTENT - 2048;
    limits.displayBytes = 1024;
    limits.thumbnailBytes = 1024;

    const result = await finalize(headers, intentId);

    expect(result.status).toBe(200);
    const db = await getDb();
    expect(await db.select().from(achievements)).toHaveLength(1);
    expect(await db.select().from(assets)).toHaveLength(1);
  });
});
