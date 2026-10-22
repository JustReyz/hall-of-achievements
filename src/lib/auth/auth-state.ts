import { sql } from 'drizzle-orm';
import { getDb } from '../db';
import { authState, sessions, type AuthState } from '../db/schema';
import { deriveAuthVersion, constantTimeCompare } from './crypto';

export class StaleInstanceError extends Error {
  constructor(message = 'Server deployment instance is stale (mismatched HMAC version)') {
    super(message);
    this.name = 'StaleInstanceError';
  }
}

/**
 * Retrieves the current singleton auth_state row from the database.
 */
export async function getActiveAuthState(): Promise<AuthState> {
  const db = await getDb();
  const rows = await db.select().from(authState).where(sql`${authState.id} = 1`);
  const record = rows[0];

  if (!record) {
    throw new Error('auth_state singleton record not found in database');
  }

  return record;
}

/**
 * Initializes or synchronizes the auth_state version with the current environment
 * if the database holds the bootstrap unconfigured placeholder.
 */
export async function syncInitialAuthState(): Promise<AuthState> {
  const current = await getActiveAuthState();
  const expectedVersion = deriveAuthVersion();

  if (current.currentVersion === 'initial_unconfigured') {
    const db = await getDb();
    const updated = await db
      .update(authState)
      .set({
        currentVersion: expectedVersion,
        rotationMetadata: { initialized: true, timestamp: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(sql`${authState.id} = 1`)
      .returning();

    const record = updated[0];
    if (record) return record;
  }

  return current;
}

/**
 * Verifies that the local serverless instance's computed auth version matches
 * the shared database active version. If mismatched, the instance is a stale deployment
 * running outdated secrets and MUST fail closed.
 */
export async function verifyInstanceAuthState(): Promise<{ valid: boolean; dbVersion: string; instanceVersion: string }> {
  const record = await syncInitialAuthState();
  const instanceVersion = deriveAuthVersion();
  const matches = constantTimeCompare(record.currentVersion, instanceVersion);

  return {
    valid: matches,
    dbVersion: record.currentVersion,
    instanceVersion,
  };
}

/**
 * Atomically rotates the authentication state in the database:
 * 1. Updates auth_state.current_version to the new version.
 * 2. Revokes all existing active sessions issued under previous versions.
 * Stale instances running old environment variables will immediately fail closed.
 */
export async function rotateAuthState(options?: {
  newVersion?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): Promise<{ newVersion: string; rotatedAt: Date; revokedSessionCount: number }> {
  const db = await getDb();
  const newVersion = options?.newVersion ?? deriveAuthVersion();
  const now = new Date();

  // Perform atomic transaction
  return await db.transaction(async (tx) => {
    // 1. Update singleton auth_state
    const updatedAuthState = await tx
      .update(authState)
      .set({
        currentVersion: newVersion,
        rotationMetadata: {
          rotatedAt: now.toISOString(),
          reason: 'secret_rotation',
          ...options?.metadata,
        },
        updatedAt: now,
      })
      .where(sql`${authState.id} = 1`)
      .returning();

    if (!updatedAuthState[0]) {
      throw new Error('Failed to update auth_state in transaction');
    }

    // 2. Revoke all existing active sessions
    const revokedSessions = await tx
      .update(sessions)
      .set({
        revoked: true,
        revokedAt: now,
      })
      .where(sql`${sessions.revoked} = FALSE`)
      .returning({ tokenHash: sessions.tokenHash });

    return {
      newVersion,
      rotatedAt: now,
      revokedSessionCount: revokedSessions.length,
    };
  });
}
