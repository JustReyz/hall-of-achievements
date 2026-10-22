import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { POST as loginHandler, GET as statusHandler, DELETE as logoutHandler } from '@/app/api/session/route';
import { POST as revokeAllHandler } from '@/app/api/sessions/revoke-all/route';
import { POST as rotateHandler } from '@/app/api/auth-state/rotate/route';
import { resetDatabase, getDb, setSimulatedDbOutage } from '@/lib/db';
import { sessions, authState } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { extractSessionToken } from '@/lib/auth/cookies';
import {
  rotateAuthState,
  getActiveAuthState,
  verifyInstanceAuthState,
  syncInitialAuthState,
} from '@/lib/auth/auth-state';
import {
  createSession,
  validateSession,
  revokeSession,
  revokeAllSessions,
  MAX_ACTIVE_SESSIONS,
} from '@/lib/auth/session';
import { checkRateLimit, recordFailedAttempt } from '@/lib/security/rate-limit';
import { deriveAuthVersion } from '@/lib/auth/crypto';

describe('Adversarial Challenge Suite: Milestone 1 Security & Resiliency', () => {
  const validCode = env.OWNER_ACCESS_CODE;
  const invalidCode = 'wrong_access_code_with_high_entropy_32_characters!';
  const baseHeaders = {
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    origin: 'http://localhost:3000',
    'x-vercel-forwarded-for': '198.51.100.55',
  };

  beforeEach(async () => {
    setSimulatedDbOutage(false);
    await resetDatabase();
  });

  afterEach(() => {
    setSimulatedDbOutage(false);
  });

  describe('1.a: Instant Revocation upon AuthState Rotation', () => {
    it('immediately rejects session with HTTP 401 upon rotation without waiting for TTL', async () => {
      const loginReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ code: validCode }),
      });
      const loginRes = await loginHandler(loginReq);
      expect(loginRes.status).toBe(200);

      const cookieHeader = loginRes.headers.get('set-cookie');
      const token = extractSessionToken(cookieHeader)!;
      expect(token).toBeTruthy();

      const checkActive = await statusHandler(
        new NextRequest('http://localhost:3000/api/session', {
          method: 'GET',
          headers: { cookie: `__Host-session=${token}` },
        })
      );
      expect(checkActive.status).toBe(200);
      const activeData = (await checkActive.json()) as { session: { expiresAt: string; idleExpiresAt: string } };
      const expiresAt = new Date(activeData.session.expiresAt).getTime();
      const idleExpiresAt = new Date(activeData.session.idleExpiresAt).getTime();
      const now = Date.now();
      expect(expiresAt - now).toBeGreaterThan(6 * 24 * 3600 * 1000);
      expect(idleExpiresAt - now).toBeGreaterThan(23 * 3600 * 1000);

      const newVersion = 'rotated_v2_hmac_secret_version_64_characters_hex_string_12345678';
      const rotateResult = await rotateAuthState({ newVersion });
      expect(rotateResult.revokedSessionCount).toBeGreaterThanOrEqual(1);

      const checkPostRotate = await statusHandler(
        new NextRequest('http://localhost:3000/api/session', {
          method: 'GET',
          headers: { cookie: `__Host-session=${token}` },
        })
      );
      expect(checkPostRotate.status).toBe(401);
      const clearCookie = checkPostRotate.headers.get('set-cookie');
      expect(clearCookie).toContain('Max-Age=0');

      const progValidation = await validateSession(token);
      expect(progValidation.valid).toBe(false);
    });

    it('adversarial tamper test: session remains rejected even if DB revoked flag is reset to false', async () => {
      const { rawToken } = await createSession();
      const val1 = await validateSession(rawToken);
      expect(val1.valid).toBe(true);

      await rotateAuthState({ newVersion: 'v2_hmac_tamper_defense_version_test_string_1234567890' });

      const db = await getDb();
      await db
        .update(sessions)
        .set({ revoked: false, revokedAt: null })
        .where(sql`${sessions.tokenHash} = ${val1.session!.tokenHash}`);

      const valOnStale = await validateSession(rawToken);
      expect(valOnStale.valid).toBe(false);
      expect(valOnStale.reason).toBe('stale_instance');

      const currentVersion = deriveAuthVersion();
      await db
        .update(authState)
        .set({ currentVersion })
        .where(sql`${authState.id} = 1`);

      await db
        .update(sessions)
        .set({
          authStateVersion: 'legacy_revoked_version_hash_00000000000000000000000000000000',
          revoked: false,
          revokedAt: null,
        })
        .where(sql`${sessions.tokenHash} = ${val1.session!.tokenHash}`);

      const valOnUpdatedInstance = await validateSession(rawToken);
      expect(valOnUpdatedInstance.valid).toBe(false);
      expect(valOnUpdatedInstance.reason).toBe('version_mismatch');

      const res = await statusHandler(
        new NextRequest('http://localhost:3000/api/session', {
          method: 'GET',
          headers: { cookie: `__Host-session=${rawToken}` },
        })
      );
      expect(res.status).toBe(401);
    });

    it('requires active session and CSRF to rotate AuthState via POST /api/auth-state/rotate', async () => {
      const unauthReq = new NextRequest('http://localhost:3000/api/auth-state/rotate', {
        method: 'POST',
        headers: baseHeaders,
      });
      const unauthRes = await rotateHandler(unauthReq);
      expect(unauthRes.status).toBe(401);

      const { rawToken } = await createSession();
      const crossOriginReq = new NextRequest('http://localhost:3000/api/auth-state/rotate', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          origin: 'http://malicious-attacker.com',
          cookie: `__Host-session=${rawToken}`,
        },
      });
      const crossOriginRes = await rotateHandler(crossOriginReq);
      expect(crossOriginRes.status).toBe(403);
    });
  });

  describe('1.b: Stale Instance Denial', () => {
    it('simulates warm serverless instance holding old secrets against rotated AuthState', async () => {
      await syncInitialAuthState();
      const initialStatus = await verifyInstanceAuthState();
      expect(initialStatus.valid).toBe(true);

      const { rawToken } = await createSession();
      expect((await validateSession(rawToken)).valid).toBe(true);

      const db = await getDb();
      const newFleetVersion = 'fleet_rotated_hmac_v2_9999999999999999999999999999999999999999';
      await db
        .update(authState)
        .set({
          currentVersion: newFleetVersion,
          updatedAt: new Date(),
        })
        .where(sql`${authState.id} = 1`);

      const staleCheck = await verifyInstanceAuthState();
      expect(staleCheck.valid).toBe(false);
      expect(staleCheck.dbVersion).toBe(newFleetVersion);
      expect(staleCheck.instanceVersion).not.toBe(newFleetVersion);

      const validation = await validateSession(rawToken);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('stale_instance');

      const getRes = await statusHandler(
        new NextRequest('http://localhost:3000/api/session', {
          method: 'GET',
          headers: { cookie: `__Host-session=${rawToken}` },
        })
      );
      expect(getRes.status).toBe(401);
      expect(getRes.headers.get('set-cookie')).toContain('Max-Age=0');
    });

    it('ADVERSARIAL ATTACK PROBE: evaluates whether a stale serverless instance allows login and mints valid V2 sessions', async () => {
      const db = await getDb();
      const newFleetVersion = 'fleet_rotated_hmac_v2_new_secret_version_abcdef0123456789';
      await db
        .update(authState)
        .set({
          currentVersion: newFleetVersion,
          updatedAt: new Date(),
        })
        .where(sql`${authState.id} = 1`);

      const loginReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ code: validCode }),
      });

      const loginRes = await loginHandler(loginReq);
      expect(loginRes.status).toBe(503);
    });
  });

  describe('1.c: Concurrency Limit Test', () => {
    it('prunes the oldest active session when creating the 6th session', async () => {
      const tokens: string[] = [];

      for (let i = 0; i < 5; i++) {
        const { rawToken } = await createSession();
        tokens.push(rawToken);
      }

      for (let i = 0; i < 5; i++) {
        const check = await validateSession(tokens[i]!);
        expect(check.valid).toBe(true);
      }

      const db = await getDb();
      const countBefore = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.revoked} = FALSE`);
      expect(countBefore.length).toBe(5);

      const { rawToken: token6 } = await createSession();

      const checkOldest = await validateSession(tokens[0]!);
      expect(checkOldest.valid).toBe(false);
      expect(checkOldest.reason).toBe('revoked');

      const resOldest = await statusHandler(
        new NextRequest('http://localhost:3000/api/session', {
          method: 'GET',
          headers: { cookie: `__Host-session=${tokens[0]}` },
        })
      );
      expect(resOldest.status).toBe(401);

      for (let i = 1; i < 5; i++) {
        const check = await validateSession(tokens[i]!);
        expect(check.valid).toBe(true);
      }
      const check6 = await validateSession(token6);
      expect(check6.valid).toBe(true);

      const countAfter = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.revoked} = FALSE`);
      expect(countAfter.length).toBe(MAX_ACTIVE_SESSIONS);
    });

    it('enforces LRU eviction: accessing an older session protects it from being pruned', async () => {
      const tokens: string[] = [];

      for (let i = 0; i < 5; i++) {
        const { rawToken } = await createSession();
        tokens.push(rawToken);
      }

      const db = await getDb();
      const futureAccessTime = new Date(Date.now() + 5000);
      await db
        .update(sessions)
        .set({ lastAccessedAt: futureAccessTime })
        .where(sql`${sessions.tokenHash} = ${tokens[0] ? (await validateSession(tokens[0])).session?.tokenHash : ''}`);

      const { rawToken: token6 } = await createSession();

      const checkS1 = await validateSession(tokens[1]!);
      expect(checkS1.valid).toBe(false);
      expect(checkS1.reason).toBe('revoked');

      const checkS0 = await validateSession(tokens[0]!);
      expect(checkS0.valid).toBe(true);

      const checkS6 = await validateSession(token6);
      expect(checkS6.valid).toBe(true);

      const count = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.revoked} = FALSE`);
      expect(count.length).toBe(5);
    });

    it('stress test: mass burst of 10 sequential sessions maintains invariant of max 5 active', async () => {
      const burstTokens: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { rawToken } = await createSession();
        burstTokens.push(rawToken);
      }

      for (let i = 0; i < 5; i++) {
        const check = await validateSession(burstTokens[i]!);
        expect(check.valid).toBe(false);
        expect(check.reason).toBe('revoked');
      }

      for (let i = 5; i < 10; i++) {
        const check = await validateSession(burstTokens[i]!);
        expect(check.valid).toBe(true);
      }

      const db = await getDb();
      const activeCount = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.revoked} = FALSE`);
      expect(activeCount.length).toBe(5);
    });

    it('stress test: concurrent session creation respects session limit without crash', async () => {
      const creationPromises = Array.from({ length: 6 }, () => createSession());
      const results = await Promise.all(creationPromises);
      expect(results.length).toBe(6);

      const db = await getDb();
      const activeCount = await db
        .select()
        .from(sessions)
        .where(sql`${sessions.revoked} = FALSE`);

      expect(activeCount.length).toBeLessThanOrEqual(6);
    });
  });

  describe('1.d: Fail-Closed Resiliency Test', () => {
    it('POST /api/session fails closed with HTTP 503 during DB outage on valid credentials', async () => {
      setSimulatedDbOutage(true);

      const loginReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ code: validCode }),
      });

      const res = await loginHandler(loginReq);
      expect(res.status).toBe(503);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Authentication service unavailable');

      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeNull();
    });

    it('POST /api/session fails closed with HTTP 503 during DB outage on invalid credentials (rate limit fail-closed)', async () => {
      setSimulatedDbOutage(true);

      const loginReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ code: invalidCode }),
      });

      const res = await loginHandler(loginReq);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Authentication service unavailable');
    });

    it('GET /api/session fails closed with HTTP 503 during DB outage', async () => {
      const { rawToken } = await createSession();

      setSimulatedDbOutage(true);

      const checkReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'GET',
        headers: { cookie: `__Host-session=${rawToken}` },
      });

      const res = await statusHandler(checkReq);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Authentication service unavailable');
    });

    it('DELETE /api/session fails closed with HTTP 503 during DB outage', async () => {
      const { rawToken } = await createSession();

      setSimulatedDbOutage(true);

      const logoutReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'DELETE',
        headers: {
          ...baseHeaders,
          cookie: `__Host-session=${rawToken}`,
        },
      });

      const res = await logoutHandler(logoutReq);
      expect(res.status).toBe(503);
    });

    it('POST /api/sessions/revoke-all fails closed with HTTP 503 during DB outage', async () => {
      const { rawToken } = await createSession();

      setSimulatedDbOutage(true);

      const revokeReq = new NextRequest('http://localhost:3000/api/sessions/revoke-all', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          cookie: `__Host-session=${rawToken}`,
        },
      });

      const res = await revokeAllHandler(revokeReq);
      expect(res.status).toBe(503);
    });

    it('POST /api/auth-state/rotate fails closed with HTTP 503 during DB outage', async () => {
      const { rawToken } = await createSession();

      setSimulatedDbOutage(true);

      const rotateReq = new NextRequest('http://localhost:3000/api/auth-state/rotate', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          cookie: `__Host-session=${rawToken}`,
        },
        body: JSON.stringify({ newVersion: 'some_new_version_string' }),
      });

      const res = await rotateHandler(rotateReq);
      expect(res.status).toBe(503);
    });

    it('Direct programmatic APIs fail closed by throwing when DB is down', async () => {
      setSimulatedDbOutage(true);

      await expect(checkRateLimit('198.51.100.1')).rejects.toThrow('Database connection failed');
      await expect(recordFailedAttempt('198.51.100.1')).rejects.toThrow('Database connection failed');
      await expect(createSession()).rejects.toThrow('Database connection failed');
      await expect(validateSession('some_token')).rejects.toThrow('Database connection failed');
      await expect(revokeSession('some_token')).rejects.toThrow('Database connection failed');
      await expect(revokeAllSessions()).rejects.toThrow('Database connection failed');
      await expect(rotateAuthState()).rejects.toThrow('Database connection failed');
      await expect(getActiveAuthState()).rejects.toThrow('Database connection failed');
    });
  });
});
