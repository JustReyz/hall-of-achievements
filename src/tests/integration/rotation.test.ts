import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as loginHandler, GET as statusHandler } from '@/app/api/session/route';
import { POST as rotateHandler } from '@/app/api/auth-state/rotate/route';
import { resetDatabase, getDb } from '@/lib/db';
import { sessions, authState } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { extractSessionToken } from '@/lib/auth/cookies';
import { rotateAuthState, getActiveAuthState, verifyInstanceAuthState } from '@/lib/auth/auth-state';
import { createSession, validateSession, StaleInstanceError } from '@/lib/auth/session';
import { sql } from 'drizzle-orm';

describe('Integration: Shared AuthState HMAC Versioning & Instant Revocation', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  const validCode = env.OWNER_ACCESS_CODE;
  const validHeaders = {
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    origin: 'http://localhost:3000',
    'x-vercel-forwarded-for': '198.51.100.22',
  };

  it('immediately denies earlier sessions upon AuthState version rotation', async () => {
    // 1. Log in and obtain valid session under Version 1
    const loginReq = new NextRequest('http://localhost:3000/api/session', {
      method: 'POST',
      headers: validHeaders,
      body: JSON.stringify({ code: validCode }),
    });
    const loginRes = await loginHandler(loginReq);
    expect(loginRes.status).toBe(200);

    const token = extractSessionToken(loginRes.headers.get('set-cookie'))!;
    expect(token).toBeTruthy();

    // 2. Verify session is currently active
    const check1 = await statusHandler(
      new NextRequest('http://localhost:3000/api/session', {
        method: 'GET',
        headers: { cookie: `__Host-session=${token}` },
      })
    );
    expect(check1.status).toBe(200);

    // 3. Trigger AuthState version rotation
    const rotateResult = await rotateAuthState({
      newVersion: 'new_rotated_hmac_version_v2_abcdef0123456789abcdef0123456789abcdef',
    });
    expect(rotateResult.revokedSessionCount).toBeGreaterThanOrEqual(1);

    // 4. Verify previous session is immediately denied with 401
    const checkAfterRotation = await statusHandler(
      new NextRequest('http://localhost:3000/api/session', {
        method: 'GET',
        headers: { cookie: `__Host-session=${token}` },
      })
    );
    expect(checkAfterRotation.status).toBe(401);
  });

  it('rotates via POST /api/auth-state/rotate endpoint', async () => {
    // 1. Log in
    const loginReq = new NextRequest('http://localhost:3000/api/session', {
      method: 'POST',
      headers: validHeaders,
      body: JSON.stringify({ code: validCode }),
    });
    const loginRes = await loginHandler(loginReq);
    const token = extractSessionToken(loginRes.headers.get('set-cookie'))!;

    // 2. Call rotation API
    const rotateReq = new NextRequest('http://localhost:3000/api/auth-state/rotate', {
      method: 'POST',
      headers: {
        ...validHeaders,
        cookie: `__Host-session=${token}`,
      },
      body: JSON.stringify({
        newVersion: 'api_rotated_version_v2_1234567890abcdef1234567890abcdef',
      }),
    });

    const rotateRes = await rotateHandler(rotateReq);
    expect(rotateRes.status).toBe(200);

    const body = (await rotateRes.json()) as { success: boolean; newVersion: string };
    expect(body.success).toBe(true);
    expect(body.newVersion).toContain('api_rotated_version_v2');

    // Caller cookie must be cleared
    const clearCookie = rotateRes.headers.get('set-cookie');
    expect(clearCookie).toContain('Max-Age=0');

    // Database auth_state must hold the new version
    const current = await getActiveAuthState();
    expect(current.currentVersion).toBe(body.newVersion);

    // Previous session must be rejected
    const checkRes = await statusHandler(
      new NextRequest('http://localhost:3000/api/session', {
        method: 'GET',
        headers: { cookie: `__Host-session=${token}` },
      })
    );
    expect(checkRes.status).toBe(401);
  });

  it('fails closed when a stale server instance has a mismatched HMAC version', async () => {
    // Simulate an external version update in database (e.g. from a newly deployed instance)
    const db = await getDb();
    await db
      .update(authState)
      .set({
        currentVersion: 'newer_deployment_version_hash_99999999999999999999999999999999',
        updatedAt: new Date(),
      })
      .where(sql`${authState.id} = 1`);

    // Verify local instance detects the mismatch
    const status = await verifyInstanceAuthState();
    expect(status.valid).toBe(false);

    // Any session validation on this stale container MUST fail closed
    const validation = await validateSession('some_random_or_existing_token');
    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('stale_instance');

    // Direct createSession() call on stale instance MUST fail closed by throwing StaleInstanceError
    await expect(createSession()).rejects.toThrow(StaleInstanceError);

    // POST /api/session login attempt on stale instance MUST fail closed with HTTP 503
    const loginReq = new NextRequest('http://localhost:3000/api/session', {
      method: 'POST',
      headers: validHeaders,
      body: JSON.stringify({ code: validCode }),
    });
    const loginRes = await loginHandler(loginReq);
    expect(loginRes.status).toBe(503);
    expect(loginRes.headers.get('set-cookie')).toBeNull();
  });

  it('enforces maximum 5 active sessions policy by revoking the oldest session', async () => {
    const createdTokens: string[] = [];

    // Create 5 active sessions
    for (let i = 0; i < 5; i++) {
      const { rawToken } = await createSession();
      createdTokens.push(rawToken);
    }

    // All 5 sessions should be valid
    for (const token of createdTokens) {
      const val = await validateSession(token);
      expect(val.valid).toBe(true);
    }

    // Create the 6th session
    const { rawToken: token6 } = await createSession();

    // The oldest session (token 0) must now be revoked
    const valOldest = await validateSession(createdTokens[0]!);
    expect(valOldest.valid).toBe(false);
    expect(valOldest.reason).toBe('revoked');

    // The newer sessions (1 through 4) and the 6th must remain valid
    for (let i = 1; i < 5; i++) {
      const val = await validateSession(createdTokens[i]!);
      expect(val.valid).toBe(true);
    }
    const val6 = await validateSession(token6);
    expect(val6.valid).toBe(true);

    // Total active non-revoked sessions in database must be exactly 5
    const db = await getDb();
    const active = await db
      .select()
      .from(sessions)
      .where(sql`${sessions.revoked} = FALSE`);
    expect(active.length).toBe(5);
  });
});
