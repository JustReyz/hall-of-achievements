import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as loginHandler, GET as statusHandler, DELETE as logoutHandler } from '@/app/api/session/route';
import { POST as revokeAllHandler } from '@/app/api/sessions/revoke-all/route';
import { resetDatabase, getDb } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { extractSessionToken } from '@/lib/auth/cookies';
import { hashSessionToken } from '@/lib/auth/crypto';

describe('Integration: Authentication & Session Lifecycle', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  const validCode = env.OWNER_ACCESS_CODE;
  const validHeaders = {
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    origin: 'http://localhost:3000',
    'x-vercel-forwarded-for': '198.51.100.10',
  };

  describe('Login Flow (POST /api/session)', () => {
    it('authenticates valid access code and sets session cookie', async () => {
      const request = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: validHeaders,
        body: JSON.stringify({ code: validCode }),
      });

      const response = await loginHandler(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.authenticated).toBe(true);
      // Zero secrets in response body
      expect(JSON.stringify(body)).not.toContain(validCode);
      expect(JSON.stringify(body)).not.toContain(env.SESSION_VERSION_KEY);

      const setCookieHeader = response.headers.get('set-cookie');
      expect(setCookieHeader).toBeTruthy();
      expect(setCookieHeader).toContain('Path=/');
      expect(setCookieHeader).toContain('HttpOnly');
      expect(setCookieHeader).toContain('SameSite=Strict');

      // Verify token in database is stored ONLY as SHA-256 hash
      const rawToken = extractSessionToken(setCookieHeader);
      expect(rawToken).toBeTruthy();
      expect(rawToken!.length).toBe(43);

      const db = await getDb();
      const allSessions = await db.select().from(sessions);
      expect(allSessions.length).toBe(1);

      const expectedHash = hashSessionToken(rawToken!);
      expect(allSessions[0]!.tokenHash).toBe(expectedHash);
      expect(allSessions[0]!.revoked).toBe(false);
    });

    it('rejects invalid access code with 401 Unauthorized in constant time', async () => {
      const request = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: validHeaders,
        body: JSON.stringify({ code: 'wrong_access_code_32_characters_long_entropy!' }),
      });

      const response = await loginHandler(request);
      expect(response.status).toBe(401);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('Invalid access code');
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('rejects malformed or empty request payload with 400 Bad Request', async () => {
      const request = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: validHeaders,
        body: 'invalid-json',
      });

      const response = await loginHandler(request);
      expect(response.status).toBe(400);
    });
  });

  describe('Session Status (GET /api/session)', () => {
    it('returns 401 when no session cookie is provided', async () => {
      const request = new NextRequest('http://localhost:3000/api/session', {
        method: 'GET',
      });

      const response = await statusHandler(request);
      expect(response.status).toBe(401);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.authenticated).toBe(false);
    });

    it('returns 200 with session expiry metadata when valid cookie is provided', async () => {
      // 1. Log in to get session cookie
      const loginReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: validHeaders,
        body: JSON.stringify({ code: validCode }),
      });
      const loginRes = await loginHandler(loginReq);
      const setCookie = loginRes.headers.get('set-cookie')!;
      const token = extractSessionToken(setCookie)!;

      // 2. Check session status
      const statusReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'GET',
        headers: {
          cookie: `__Host-session=${token}`,
        },
      });

      const statusRes = await statusHandler(statusReq);
      expect(statusRes.status).toBe(200);

      const body = (await statusRes.json()) as {
        authenticated: boolean;
        session: { expiresAt: string; idleExpiresAt: string };
      };
      expect(body.authenticated).toBe(true);
      expect(body.session.expiresAt).toBeTruthy();
      expect(body.session.idleExpiresAt).toBeTruthy();
    });
  });

  describe('Logout (DELETE /api/session)', () => {
    it('revokes current session in database and clears session cookie', async () => {
      // 1. Log in
      const loginReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: validHeaders,
        body: JSON.stringify({ code: validCode }),
      });
      const loginRes = await loginHandler(loginReq);
      const token = extractSessionToken(loginRes.headers.get('set-cookie'))!;

      // 2. Log out
      const logoutReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'DELETE',
        headers: {
          ...validHeaders,
          cookie: `__Host-session=${token}`,
        },
      });

      const logoutRes = await logoutHandler(logoutReq);
      expect(logoutRes.status).toBe(200);
      const logoutBody = (await logoutRes.json()) as Record<string, unknown>;
      expect(logoutBody.success).toBe(true);

      const clearCookie = logoutRes.headers.get('set-cookie');
      expect(clearCookie).toContain('Max-Age=0');

      // 3. Verify session is marked revoked in database
      const db = await getDb();
      const allSessions = await db.select().from(sessions);
      expect(allSessions.length).toBe(1);
      expect(allSessions[0]!.revoked).toBe(true);
      expect(allSessions[0]!.revokedAt).not.toBeNull();

      // 4. Verify subsequent GET /api/session returns 401
      const checkReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'GET',
        headers: { cookie: `__Host-session=${token}` },
      });
      const checkRes = await statusHandler(checkReq);
      expect(checkRes.status).toBe(401);
    });
  });

  describe('Bulk Revocation (POST /api/sessions/revoke-all)', () => {
    it('revokes all active sessions across all devices', async () => {
      // 1. Create two separate sessions
      const req1 = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: { ...validHeaders, 'x-vercel-forwarded-for': '198.51.100.1' },
        body: JSON.stringify({ code: validCode }),
      });
      const res1 = await loginHandler(req1);
      const token1 = extractSessionToken(res1.headers.get('set-cookie'))!;

      const req2 = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: { ...validHeaders, 'x-vercel-forwarded-for': '198.51.100.2' },
        body: JSON.stringify({ code: validCode }),
      });
      const res2 = await loginHandler(req2);
      const token2 = extractSessionToken(res2.headers.get('set-cookie'))!;

      // 2. Call revoke-all with token1
      const revokeReq = new NextRequest('http://localhost:3000/api/sessions/revoke-all', {
        method: 'POST',
        headers: {
          ...validHeaders,
          cookie: `__Host-session=${token1}`,
        },
      });

      const revokeRes = await revokeAllHandler(revokeReq);
      expect(revokeRes.status).toBe(200);
      const body = (await revokeRes.json()) as { success: boolean; revokedCount: number };
      expect(body.success).toBe(true);
      expect(body.revokedCount).toBe(2);

      // 3. Verify BOTH sessions are now denied
      const check1 = await statusHandler(
        new NextRequest('http://localhost:3000/api/session', {
          method: 'GET',
          headers: { cookie: `__Host-session=${token1}` },
        })
      );
      expect(check1.status).toBe(401);

      const check2 = await statusHandler(
        new NextRequest('http://localhost:3000/api/session', {
          method: 'GET',
          headers: { cookie: `__Host-session=${token2}` },
        })
      );
      expect(check2.status).toBe(401);
    });
  });

  describe('CSRF & Origin Enforcement', () => {
    it('rejects mutating requests from foreign origins with 403 Forbidden', async () => {
      const maliciousReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: {
          ...validHeaders,
          origin: 'https://malicious-attacker.com',
        },
        body: JSON.stringify({ code: validCode }),
      });

      const res = await loginHandler(maliciousReq);
      expect(res.status).toBe(403);
    });

    it('rejects mutating requests with null origin', async () => {
      const nullOriginReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: {
          ...validHeaders,
          origin: 'null',
        },
        body: JSON.stringify({ code: validCode }),
      });

      const res = await loginHandler(nullOriginReq);
      expect(res.status).toBe(403);
    });

    it('rejects cross-site requests indicated by Sec-Fetch-Site', async () => {
      const crossSiteReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: {
          ...validHeaders,
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({ code: validCode }),
      });

      const res = await loginHandler(crossSiteReq);
      expect(res.status).toBe(403);
    });
  });
});
