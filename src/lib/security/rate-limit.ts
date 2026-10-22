import { sql } from 'drizzle-orm';
import { getDb } from '../db';
import { rateLimits } from '../db/schema';
import { hashClientIp } from '../auth/crypto';

export const RATE_LIMIT_MAX_ATTEMPTS = 5;
export const RATE_LIMIT_WINDOW_SECONDS = 15 * 60; // 15 minutes = 900 seconds
export const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_SECONDS * 1000;

export interface RateLimitStatus {
  allowed: boolean;
  attemptCount: number;
  remainingAttempts: number;
  retryAfterSeconds: number;
}

/**
 * Extracts client IP from trusted platform headers in priority order,
 * rejecting spoofed X-Forwarded-For headers from untrusted clients.
 */
export function extractClientIp(headersOrRequest: Headers | Request): string {
  const headers = headersOrRequest instanceof Request ? headersOrRequest.headers : headersOrRequest;

  // 1. Vercel trusted proxy header
  const vercelIp = headers.get('x-vercel-forwarded-for');
  if (vercelIp) {
    const candidate = vercelIp.split(',')[0]?.trim();
    if (candidate) return candidate;
  }

  // 2. Reverse proxy real IP header
  const realIp = headers.get('x-real-ip');
  if (realIp) {
    const candidate = realIp.split(',')[0]?.trim();
    if (candidate) return candidate;
  }

  // 3. Cloudflare tunnel header
  const cfIp = headers.get('cf-connecting-ip');
  if (cfIp) {
    const candidate = cfIp.split(',')[0]?.trim();
    if (candidate) return candidate;
  }

  // Fallback to loopback
  return '127.0.0.1';
}

/**
 * Inspects whether the client IP hash is currently rate limited.
 * Fails closed by throwing if database is unreachable.
 */
export async function checkRateLimit(ip: string): Promise<RateLimitStatus> {
  const db = await getDb();
  const hashedKey = `login:${hashClientIp(ip)}`;
  const now = new Date();

  const results = await db
    .select()
    .from(rateLimits)
    .where(sql`${rateLimits.key} = ${hashedKey}`);

  const record = results[0];

  if (!record) {
    return {
      allowed: true,
      attemptCount: 0,
      remainingAttempts: RATE_LIMIT_MAX_ATTEMPTS,
      retryAfterSeconds: 0,
    };
  }

  const windowStartTime = new Date(record.windowStart).getTime();
  const elapsedMs = now.getTime() - windowStartTime;

  // Window has expired
  if (elapsedMs >= RATE_LIMIT_WINDOW_MS) {
    return {
      allowed: true,
      attemptCount: 0,
      remainingAttempts: RATE_LIMIT_MAX_ATTEMPTS,
      retryAfterSeconds: 0,
    };
  }

  const attemptCount = record.attemptCount;

  if (attemptCount >= RATE_LIMIT_MAX_ATTEMPTS) {
    const remainingMs = Math.max(0, RATE_LIMIT_WINDOW_MS - elapsedMs);
    const retryAfterSeconds = Math.ceil(remainingMs / 1000);
    return {
      allowed: false,
      attemptCount,
      remainingAttempts: 0,
      retryAfterSeconds,
    };
  }

  return {
    allowed: true,
    attemptCount,
    remainingAttempts: Math.max(0, RATE_LIMIT_MAX_ATTEMPTS - attemptCount),
    retryAfterSeconds: 0,
  };
}

/**
 * Atomically increments failed attempt counter for client IP in database.
 * If current window has expired, resets counter to 1 with new window.
 * Fails closed by throwing if database write fails.
 */
export async function recordFailedAttempt(ip: string): Promise<RateLimitStatus> {
  const db = await getDb();
  const hashedKey = `login:${hashClientIp(ip)}`;
  const now = new Date();

  // Atomic UPSERT using Drizzle with onConflictDoUpdate
  const upserted = await db
    .insert(rateLimits)
    .values({
      key: hashedKey,
      scope: 'login_ip',
      attemptCount: 1,
      windowStart: now,
      blockedUntil: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        attemptCount: sql`
          CASE
            WHEN ${rateLimits.windowStart} + INTERVAL '15 minutes' < ${now} THEN 1
            ELSE ${rateLimits.attemptCount} + 1
          END
        `,
        windowStart: sql`
          CASE
            WHEN ${rateLimits.windowStart} + INTERVAL '15 minutes' < ${now} THEN ${now}
            ELSE ${rateLimits.windowStart}
          END
        `,
        blockedUntil: sql`
          CASE
            WHEN (${rateLimits.windowStart} + INTERVAL '15 minutes' >= ${now}) AND (${rateLimits.attemptCount} + 1 >= ${RATE_LIMIT_MAX_ATTEMPTS})
              THEN ${rateLimits.windowStart} + INTERVAL '15 minutes'
            WHEN (${rateLimits.windowStart} + INTERVAL '15 minutes' < ${now})
              THEN NULL
            ELSE ${rateLimits.blockedUntil}
          END
        `,
        updatedAt: now,
      },
    })
    .returning();

  const record = upserted[0];
  if (!record) {
    throw new Error('Rate limit record could not be updated');
  }

  const attemptCount = record.attemptCount;
  const isAllowed = attemptCount <= RATE_LIMIT_MAX_ATTEMPTS;
  const elapsedMs = now.getTime() - new Date(record.windowStart).getTime();
  const remainingMs = Math.max(0, RATE_LIMIT_WINDOW_MS - elapsedMs);
  const retryAfterSeconds = isAllowed ? 0 : Math.ceil(remainingMs / 1000);

  return {
    allowed: isAllowed,
    attemptCount,
    remainingAttempts: Math.max(0, RATE_LIMIT_MAX_ATTEMPTS - attemptCount),
    retryAfterSeconds,
  };
}

/**
 * Resets rate limit for a client IP (e.g. after successful authentication or test cleanup).
 */
export async function resetRateLimit(ip: string): Promise<void> {
  const db = await getDb();
  const hashedKey = `login:${hashClientIp(ip)}`;
  await db.delete(rateLimits).where(sql`${rateLimits.key} = ${hashedKey}`);
}
