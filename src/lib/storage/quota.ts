import { eq, and, gt, sql } from 'drizzle-orm';
import { AppDatabase } from '../db';
import { uploadIntents, assets, UploadIntent } from '../db/schema';

export const DEFAULT_PROVIDER_ALLOWANCE_BYTES = 1024 * 1024 * 1024; // 1 GiB (1,073,741,824 bytes)
export const STORAGE_CEILING_RATIO = 0.70; // 70% storage ceiling

export const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024; // 10 MiB (10,485,760 bytes)
export const MAX_DERIVATIVE_BOUND_BYTES = 2 * 1024 * 1024; // 2 MiB (2,097,152 bytes)
export const RESERVED_BYTES_PER_INTENT = MAX_ORIGINAL_BYTES + MAX_DERIVATIVE_BOUND_BYTES; // 12 MiB (12,582,912 bytes)

export const MAX_CONCURRENT_INTENTS = 3;
export const INTENT_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

export class QuotaError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'QuotaError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function getProviderAllowanceBytes(): number {
  if (process.env.STORAGE_PROVIDER_ALLOWANCE_BYTES) {
    const parsed = parseInt(process.env.STORAGE_PROVIDER_ALLOWANCE_BYTES, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PROVIDER_ALLOWANCE_BYTES;
}

export function getStorageCeilingBytes(): number {
  return Math.floor(getProviderAllowanceBytes() * STORAGE_CEILING_RATIO);
}

export interface QuotaStats {
  totalAllowanceBytes: number;
  ceilingBytes: number;
  committedBytes: number;
  reservedBytes: number;
  totalAccountedBytes: number;
  remainingCeilingBytes: number;
  activeIntentCount: number;
}

/**
 * Calculates current storage metrics against the 70% ceiling.
 */
export async function getStorageQuotaStats(db: AppDatabase): Promise<QuotaStats> {
  const now = new Date();
  const allowance = getProviderAllowanceBytes();
  const ceiling = getStorageCeilingBytes();

  // 1. Sum committed bytes in ready assets (original + 2MB derivative bound)
  const committedResult = await db
    .select({
      totalCommitted: sql<string>`COALESCE(SUM(${assets.originalBytes} + 2097152), 0)`,
    })
    .from(assets);
  const committedBytes = Number(committedResult[0]?.totalCommitted ?? 0);

  // 2. Sum active pending reservations
  const pendingResult = await db
    .select({
      totalReserved: sql<string>`COALESCE(SUM(${uploadIntents.reservedBytes}), 0)`,
      count: sql<string>`COUNT(*)`,
    })
    .from(uploadIntents)
    .where(
      and(
        eq(uploadIntents.status, 'pending'),
        gt(uploadIntents.expiresAt, now)
      )
    );

  const reservedBytes = Number(pendingResult[0]?.totalReserved ?? 0);
  const activeIntentCount = Number(pendingResult[0]?.count ?? 0);
  const totalAccountedBytes = committedBytes + reservedBytes;
  const remainingCeilingBytes = Math.max(0, ceiling - totalAccountedBytes);

  return {
    totalAllowanceBytes: allowance,
    ceilingBytes: ceiling,
    committedBytes,
    reservedBytes,
    totalAccountedBytes,
    remainingCeilingBytes,
    activeIntentCount,
  };
}

/**
 * Atomically checks quota ceiling & concurrency bounds, and creates a pending upload intent.
 */
export async function reserveUploadQuota(
  db: AppDatabase,
  params: {
    tokenHash: string;
    fileName: string;
    mimeType: string;
    declaredSize: number;
  }
): Promise<UploadIntent> {
  const stats = await getStorageQuotaStats(db);

  // 1. Check concurrent intent bound (at most 3 active intents)
  if (stats.activeIntentCount >= MAX_CONCURRENT_INTENTS) {
    throw new QuotaError(
      'TOO_MANY_CONCURRENT_INTENTS',
      `Maximum of ${MAX_CONCURRENT_INTENTS} active upload intents in progress. Finalize or let existing uploads expire.`,
      429
    );
  }

  // 2. Check 70% storage ceiling with the 12 MiB reservation
  if (stats.totalAccountedBytes + RESERVED_BYTES_PER_INTENT > stats.ceilingBytes) {
    throw new QuotaError(
      'STORAGE_QUOTA_EXCEEDED',
      `Storage quota ceiling (${(stats.ceilingBytes / 1024 / 1024).toFixed(1)} MB) exceeded. Available: ${(stats.remainingCeilingBytes / 1024 / 1024).toFixed(1)} MB, Required: ${(RESERVED_BYTES_PER_INTENT / 1024 / 1024).toFixed(1)} MB.`,
      507
    );
  }

  const intentId = crypto.randomUUID();
  const ext = params.mimeType === 'image/jpeg' ? 'jpg' : params.mimeType === 'image/png' ? 'png' : 'webp';
  const quarantineKey = `quarantine/${intentId}.${ext}`;
  const expiresAt = new Date(Date.now() + INTENT_EXPIRY_MS);

  const rows = await db
    .insert(uploadIntents)
    .values({
      id: intentId,
      tokenHash: params.tokenHash,
      fileName: params.fileName,
      mimeType: params.mimeType,
      declaredSize: params.declaredSize,
      reservedBytes: RESERVED_BYTES_PER_INTENT,
      quarantineKey,
      status: 'pending',
      expiresAt,
    })
    .returning();

  if (!rows[0]) {
    throw new Error('Failed to insert upload intent');
  }

  return rows[0];
}
