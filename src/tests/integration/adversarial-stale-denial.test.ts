import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { POST as loginHandler, GET as statusHandler, DELETE as logoutHandler } from '@/app/api/session/route';
import { POST as revokeAllHandler } from '@/app/api/sessions/revoke-all/route';
import { resetDatabase, getDb, setSimulatedDbOutage } from '@/lib/db';
import { sessions, authState } from '@/lib/db/schema';
import { env } from '@/lib/env';
import {
  rotateAuthState,
  verifyInstanceAuthState,
  syncInitialAuthState,
  StaleInstanceError,
} from '@/lib/auth/auth-state';
import {
  createSession,
  validateSession,
} from '@/lib/auth/session';
import { deriveAuthVersion } from '@/lib/auth/crypto';

describe('Adversarial Challenger Suite 2 Iteration 2: Stale Instance Denial & Session Lifecycle', () => {
  const validCode = env.OWNER_ACCESS_CODE;
  const invalidCode = 'wrong_access_code_for_adversarial_testing_123456';
  const baseHeaders = {
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    origin: 'http://localhost:3000',
    'x-vercel-forwarded-for': '198.51.100.77',
  };

  beforeEach(async () => {
    setSimulatedDbOutage(false);
    await resetDatabase();
  });

  afterEach(() => {
    setSimulatedDbOutage(false);
  });

  describe('Section 1: Stale Instance Denial & Fail-Closed Behavior', () => {
    it('denies POST /api/session on stale instance: returns 503, sets NO cookie, mints ZERO sessions in PostgreSQL', async () => {
      const db = await getDb();

      await syncInitialAuthState();
      const localVersion = deriveAuthVersion();
      const initialStatus = await verifyInstanceAuthState();
      expect(initialStatus.valid).toBe(true);

      const rotatedDbVersion = 'fleet_rotated_hmac_v2_9999999999999999999999999999999999999999';
      await db
        .update(authState)
        .set({
          currentVersion: rotatedDbVersion,
          updatedAt: new Date(),
        })
        .where(sql`${authState.id} = 1`);

      const staleStatus = await verifyInstanceAuthState();
      expect(staleStatus.valid).toBe(false);
      expect(staleStatus.dbVersion).toBe(rotatedDbVersion);
      expect(staleStatus.instanceVersion).toBe(localVersion);

      const loginReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ code: validCode }),
      });

      const loginRes = await loginHandler(loginReq);
      expect(loginRes.status).toBe(503);

      const body = (await loginRes.json()) as { error: string };
      expect(body.error).toBe('Authentication service unavailable');

      const setCookie = loginRes.headers.get('set-cookie');
      expect(setCookie).toBeNull();

      const sessionRows = await db.select().from(sessions);
      expect(sessionRows.length).toBe(0);

      const badLoginReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'x-vercel-forwarded-for': '198.51.100.88',
        },
        body: JSON.stringify({ code: invalidCode }),
      });

      const badLoginRes = await loginHandler(badLoginReq);
      expect(badLoginRes.status).toBe(503);
      expect(badLoginRes.headers.get('set-cookie')).toBeNull();

      const sessionRowsAfter = await db.select().from(sessions);
      expect(sessionRowsAfter.length).toBe(0);
    });

    it('rejects programmatic createSession() on stale instance by throwing StaleInstanceError prior to DB insertion', async () => {
      const db = await getDb();

      await syncInitialAuthState();
      const rotatedDbVersion = 'rotated_version_for_direct_create_session_test_99999';
      await db
        .update(authState)
        .set({
          currentVersion: rotatedDbVersion,
          updatedAt: new Date(),
        })
        .where(sql`${authState.id} = 1`);

      let thrownError: unknown = null;
      try {
        await createSession();
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(StaleInstanceError);
      expect((thrownError as Error).name).toBe('StaleInstanceError');
      expect((thrownError as Error).message).toContain('Cannot create session on stale instance');

      const sessionRecords = await db.select().from(sessions);
      expect(sessionRecords.length).toBe(0);
    });

    it('rejects validateSession() on stale instance with stale_instance reason', async () => {
      const db = await getDb();

      const { rawToken } = await createSession();
      const activeCheck = await validateSession(rawToken);
      expect(activeCheck.valid).toBe(true);

      await db
        .update(authState)
        .set({
          currentVersion: 'new_db_active_hmac_version_after_session_creation',
          updatedAt: new Date(),
        })
        .where(sql`${authState.id} = 1`);

      const staleValidation = await validateSession(rawToken);
      expect(staleValidation.valid).toBe(false);
      expect(staleValidation.reason).toBe('stale_instance');

      const getRes = await statusHandler(
        new NextRequest('http://localhost:3000/api/session', {
          method: 'GET',
          headers: { cookie: `__Host-session=${rawToken}` },
        })
      );
      expect(getRes.status).toBe(401);
      expect(getRes.headers.get('set-cookie')).toContain('Max-Age=0');
    });
  });

  describe('Section 2: Instant Revocation upon AuthState Rotation', () => {
    it('immediately invalidates all sessions upon AuthState version rotation', async () => {
      const session1 = await createSession();
      const session2 = await createSession();
      const session3 = await createSession();

      expect((await validateSession(session1.rawToken)).valid).toBe(true);
      expect((await validateSession(session2.rawToken)).valid).toBe(true);
      expect((await validateSession(session3.rawToken)).valid).toBe(true);

      const rotationResult = await rotateAuthState({
        newVersion: 'new_active_hmac_v2_instant_revocation_stress_test_12345',
        metadata: { triggeredBy: 'security_audit' },
      });

      expect(rotationResult.revokedSessionCount).toBe(3);

      const val1 = await validateSession(session1.rawToken);
      const val2 = await validateSession(session2.rawToken);
      const val3 = await validateSession(session3.rawToken);

      expect(val1.valid).toBe(false);
      expect(val2.valid).toBe(false);
      expect(val3.valid).toBe(false);

      for (const s of [session1, session2, session3]) {
        const res = await statusHandler(
          new NextRequest('http://localhost:3000/api/session', {
            method: 'GET',
            headers: { cookie: `__Host-session=${s.rawToken}` },
          })
        );
        expect(res.status).toBe(401);
        expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
      }
    });

    it('tamper resistance: manually unrevoking a session in DB still fails due to HMAC version mismatch', async () => {
      const db = await getDb();

      const { rawToken, session } = await createSession();
      expect((await validateSession(rawToken)).valid).toBe(true);

      await rotateAuthState({ newVersion: 'v2_new_secure_version_987654321' });

      await db
        .update(sessions)
        .set({ revoked: false, revokedAt: null })
        .where(sql`${sessions.tokenHash} = ${session.tokenHash}`);

      const val = await validateSession(rawToken);
      expect(val.valid).toBe(false);
      expect(['stale_instance', 'version_mismatch']).toContain(val.reason);
    });

    it('POST /api/sessions/revoke-all bulk revokes all active sessions', async () => {
      const s1 = await createSession();
      const s2 = await createSession();
      const s3 = await createSession();

      const req = new NextRequest('http://localhost:3000/api/sessions/revoke-all', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          cookie: `__Host-session=${s1.rawToken}`,
        },
      });

      const res = await revokeAllHandler(req);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; revokedCount: number };
      expect(body.success).toBe(true);
      expect(body.revokedCount).toBe(3);

      expect((await validateSession(s1.rawToken)).valid).toBe(false);
      expect((await validateSession(s2.rawToken)).valid).toBe(false);
      expect((await validateSession(s3.rawToken)).valid).toBe(false);
    });
  });

  describe('Section 3: Concurrency Limit (Max 5 Active Sessions)', () => {
    it('strictly maintains max 5 active sessions: creating 6th revokes the oldest', async () => {
      const tokens: string[] = [];

      for (let i = 0; i < 5; i++) {
        const { rawToken } = await createSession();
        tokens.push(rawToken);
      }

      for (let i = 0; i < 5; i++) {
        const val = await validateSession(tokens[i]!);
        expect(val.valid).toBe(true);
      }

      const db = await getDb();
      const active5 = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.revoked} = FALSE`);
      expect(active5.length).toBe(5);

      const { rawToken: token6 } = await createSession();

      const val0 = await validateSession(tokens[0]!);
      expect(val0.valid).toBe(false);
      expect(val0.reason).toBe('revoked');

      for (let i = 1; i < 5; i++) {
        const val = await validateSession(tokens[i]!);
        expect(val.valid).toBe(true);
      }
      expect((await validateSession(token6)).valid).toBe(true);

      const activeAfter6 = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.revoked} = FALSE`);
      expect(activeAfter6.length).toBe(5);
    });

    it('enforces LRU order: touching older session slides lastAccessedAt and protects it from pruning', async () => {
      const tokens: string[] = [];

      for (let i = 0; i < 5; i++) {
        const { rawToken } = await createSession();
        tokens.push(rawToken);
      }

      const touch0 = await validateSession(tokens[0]!);
      expect(touch0.valid).toBe(true);

      const { rawToken: token6 } = await createSession();

      const val0 = await validateSession(tokens[0]!);
      expect(val0.valid).toBe(true);

      const val1 = await validateSession(tokens[1]!);
      expect(val1.valid).toBe(false);
      expect(val1.reason).toBe('revoked');

      const val6 = await validateSession(token6);
      expect(val6.valid).toBe(true);

      const db = await getDb();
      const activeCount = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.revoked} = FALSE`);
      expect(activeCount.length).toBe(5);
    });

    it('mass burst stress test: creating 20 sequential sessions maintains max 5 invariant throughout', async () => {
      const db = await getDb();
      const createdTokens: string[] = [];

      for (let i = 0; i < 20; i++) {
        const { rawToken } = await createSession();
        createdTokens.push(rawToken);

        const currentActive = await db
          .select()
          .from(sessions)
          .where(sql`${sessions.revoked} = FALSE`);
        expect(currentActive.length).toBeLessThanOrEqual(5);
      }

      const finalActive = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.revoked} = FALSE`);
      expect(finalActive.length).toBe(5);

      const last5Tokens = createdTokens.slice(-5);
      for (const t of last5Tokens) {
        const val = await validateSession(t);
        expect(val.valid).toBe(true);
      }

      const first15Tokens = createdTokens.slice(0, 15);
      for (const t of first15Tokens) {
        const val = await validateSession(t);
        expect(val.valid).toBe(false);
        expect(val.reason).toBe('revoked');
      }
    });
  });

  describe('Section 4: Session Lifecycle Expiration & Revocation Edge Cases', () => {
    it('DELETE /api/session revokes token and clears cookie', async () => {
      const { rawToken } = await createSession();
      expect((await validateSession(rawToken)).valid).toBe(true);

      const logoutReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'DELETE',
        headers: {
          ...baseHeaders,
          cookie: `__Host-session=${rawToken}`,
        },
      });

      const logoutRes = await logoutHandler(logoutReq);
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0');

      const val = await validateSession(rawToken);
      expect(val.valid).toBe(false);
      expect(val.reason).toBe('revoked');
    });

    it('rejects expired sessions (absolute expiration > 7 days)', async () => {
      const db = await getDb();
      const { rawToken, session } = await createSession();

      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await db
        .update(sessions)
        .set({ expiresAt: eightDaysAgo })
        .where(sql`${sessions.tokenHash} = ${session.tokenHash}`);

      const val = await validateSession(rawToken);
      expect(val.valid).toBe(false);
      expect(val.reason).toBe('absolute_expired');
    });

    it('rejects idle expired sessions (idle > 24 hours)', async () => {
      const db = await getDb();
      const { rawToken, session } = await createSession();

      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await db
        .update(sessions)
        .set({ lastAccessedAt: twentyFiveHoursAgo })
        .where(sql`${sessions.tokenHash} = ${session.tokenHash}`);

      const val = await validateSession(rawToken);
      expect(val.valid).toBe(false);
      expect(val.reason).toBe('idle_expired');
    });
  });
});
