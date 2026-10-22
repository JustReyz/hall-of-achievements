import { sql } from 'drizzle-orm';
import { getDb } from '../db';
import { sessions, type Session } from '../db/schema';
import {
  generateSessionToken,
  hashSessionToken,
  constantTimeCompare,
  deriveAuthVersion,
} from './crypto';
import {
  getActiveAuthState,
  syncInitialAuthState,
  StaleInstanceError,
} from './auth-state';

export { StaleInstanceError };

export const IDLE_TIMEOUT_SECONDS = 24 * 60 * 60; // 24 hours
export const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_SECONDS * 1000;
export const ABSOLUTE_TIMEOUT_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const ABSOLUTE_TIMEOUT_MS = ABSOLUTE_TIMEOUT_SECONDS * 1000;
export const MAX_ACTIVE_SESSIONS = 5;

export interface SessionValidationResult {
  valid: boolean;
  session?: Session;
  reason?: 'not_found' | 'revoked' | 'idle_expired' | 'absolute_expired' | 'version_mismatch' | 'stale_instance';
}

/**
 * Creates a new active session with CSPRNG token and binds it to the active AuthState version.
 * Automatically enforces the 5 concurrent active sessions limit by revoking the oldest active session.
 */
export async function createSession(): Promise<{ rawToken: string; session: Session }> {
  const db = await getDb();
  const currentAuthState = await syncInitialAuthState();
  const activeVersion = currentAuthState.currentVersion;

  // Enforce fail-closed check on instance version before creating any session
  const localVersion = deriveAuthVersion();
  if (!constantTimeCompare(localVersion, activeVersion)) {
    console.error('[SECURITY FATAL] Stale instance detected: local HMAC does not match DB auth_state');
    throw new StaleInstanceError('Cannot create session on stale instance with mismatched AuthState version');
  }

  const { rawToken, tokenHash } = generateSessionToken();
  const now = new Date();
  const idleExpiresAt = new Date(now.getTime() + IDLE_TIMEOUT_MS);
  const expiresAt = new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS);

  return await db.transaction(async (tx) => {
    // 1. Check existing active session count
    const activeRows = await tx
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(
        sql`${sessions.revoked} = FALSE
          AND ${sessions.expiresAt} > ${now}
          AND ${sessions.idleExpiresAt} > ${now}
          AND ${sessions.authStateVersion} = ${activeVersion}`
      )
      .orderBy(sessions.lastAccessedAt);

    // If 5 or more active sessions, prune the oldest to maintain max 5
    if (activeRows.length >= MAX_ACTIVE_SESSIONS) {
      const excessCount = activeRows.length - MAX_ACTIVE_SESSIONS + 1;
      const oldestToRevoke = activeRows.slice(0, excessCount);

      for (const item of oldestToRevoke) {
        await tx
          .update(sessions)
          .set({ revoked: true, revokedAt: now })
          .where(sql`${sessions.tokenHash} = ${item.tokenHash}`);
      }
    }

    // 2. Insert new session record
    const inserted = await tx
      .insert(sessions)
      .values({
        tokenHash,
        authStateVersion: activeVersion,
        createdAt: now,
        lastAccessedAt: now,
        idleExpiresAt,
        expiresAt,
        revoked: false,
        revokedAt: null,
      })
      .returning();

    const newSession = inserted[0];
    if (!newSession) {
      throw new Error('Failed to insert new session into database');
    }

    return { rawToken, session: newSession };
  });
}

/**
 * Validates a session token:
 * - Checks existence and revoked flag
 * - Enforces 24-hour sliding idle timeout
 * - Enforces 7-day absolute lifetime
 * - Enforces AuthState HMAC active version match
 * - Enforces local instance deployment version match
 * Slides idle window on successful validation.
 */
export async function validateSession(rawToken: string): Promise<SessionValidationResult> {
  if (!rawToken || typeof rawToken !== 'string') {
    return { valid: false, reason: 'not_found' };
  }

  const tokenHash = hashSessionToken(rawToken);
  const db = await getDb();
  const now = new Date();

  // 1. Fetch active AuthState
  const currentAuthState = await getActiveAuthState();
  const dbActiveVersion = currentAuthState.currentVersion;

  // 2. Check local instance version against database active version
  const localVersion = deriveAuthVersion();
  if (!constantTimeCompare(localVersion, dbActiveVersion)) {
    console.error('[SECURITY FATAL] Stale instance detected: local HMAC does not match DB auth_state');
    return { valid: false, reason: 'stale_instance' };
  }

  // 3. Query session record
  const rows = await db
    .select()
    .from(sessions)
    .where(sql`${sessions.tokenHash} = ${tokenHash}`);

  const session = rows[0];

  if (!session) {
    return { valid: false, reason: 'not_found' };
  }

  // 4. Check revoked flag
  if (session.revoked || session.revokedAt !== null) {
    return { valid: false, reason: 'revoked' };
  }

  // 5. Check AuthState version match
  if (!constantTimeCompare(session.authStateVersion, dbActiveVersion)) {
    return { valid: false, reason: 'version_mismatch' };
  }

  // 6. Check absolute 7-day expiration
  if (now.getTime() >= new Date(session.expiresAt).getTime()) {
    // Automatically mark revoked in background
    await db
      .update(sessions)
      .set({ revoked: true, revokedAt: now })
      .where(sql`${sessions.tokenHash} = ${tokenHash}`);
    return { valid: false, reason: 'absolute_expired' };
  }

  // 7. Check 24-hour sliding idle expiration
  const lastAccessedTime = new Date(session.lastAccessedAt).getTime();
  if (now.getTime() - lastAccessedTime >= IDLE_TIMEOUT_MS) {
    await db
      .update(sessions)
      .set({ revoked: true, revokedAt: now })
      .where(sql`${sessions.tokenHash} = ${tokenHash}`);
    return { valid: false, reason: 'idle_expired' };
  }

  // 8. Session is valid; slide the idle window (capped at absolute expiresAt)
  const newIdleTime = Math.min(now.getTime() + IDLE_TIMEOUT_MS, new Date(session.expiresAt).getTime());
  const updatedIdleExpiresAt = new Date(newIdleTime);

  const updatedRows = await db
    .update(sessions)
    .set({
      lastAccessedAt: now,
      idleExpiresAt: updatedIdleExpiresAt,
    })
    .where(sql`${sessions.tokenHash} = ${tokenHash}`)
    .returning();

  return {
    valid: true,
    session: updatedRows[0] ?? session,
  };
}

/**
 * Revokes a single session by its raw token or token hash.
 */
export async function revokeSession(rawTokenOrHash: string): Promise<boolean> {
  if (!rawTokenOrHash) return false;

  const db = await getDb();
  const tokenHash = rawTokenOrHash.length === 64 ? rawTokenOrHash : hashSessionToken(rawTokenOrHash);
  const now = new Date();

  const updated = await db
    .update(sessions)
    .set({
      revoked: true,
      revokedAt: now,
    })
    .where(sql`${sessions.tokenHash} = ${tokenHash}`)
    .returning();

  return updated.length > 0;
}

/**
 * Revokes all active sessions across all devices.
 */
export async function revokeAllSessions(): Promise<number> {
  const db = await getDb();
  const now = new Date();

  const revoked = await db
    .update(sessions)
    .set({
      revoked: true,
      revokedAt: now,
    })
    .where(sql`${sessions.revoked} = FALSE`)
    .returning({ tokenHash: sessions.tokenHash });

  return revoked.length;
}
