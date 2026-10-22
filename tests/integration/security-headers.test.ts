import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import nextConfig from '../../next.config';
import { resetDatabase } from '@/lib/db';
import { POST as sessionPost, GET as sessionGet } from '@/app/api/session/route';
import { POST as revokeAllPost } from '@/app/api/sessions/revoke-all/route';
import { POST as rotateAuthStatePost } from '@/app/api/auth-state/rotate/route';
import { GET as getAchievements } from '@/app/api/achievements/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';

describe('Integration: Security Headers & Cache-Control Hardening (AC12)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('Next.js Configuration Headers (next.config.ts)', () => {
    it('defines strict security headers for all application routes (/:path*)', async () => {
      expect(nextConfig.headers).toBeDefined();
      const headersConfig = await nextConfig.headers!();

      const globalRoute = headersConfig.find((r) => r.source === '/:path*');
      expect(globalRoute).toBeDefined();

      const headerMap = new Map(globalRoute!.headers.map((h) => [h.key, h.value]));

      // 1. Anti-clickjacking & framing
      expect(headerMap.get('X-Frame-Options')).toBe('DENY');

      // 2. MIME type sniffing prevention
      expect(headerMap.get('X-Content-Type-Options')).toBe('nosniff');

      // 3. Referrer policy
      expect(headerMap.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');

      // 4. Permissions policy
      expect(headerMap.get('Permissions-Policy')).toBe(
        'camera=(), microphone=(), geolocation=()'
      );

      // 5. Content Security Policy (CSP)
      const csp = headerMap.get('Content-Security-Policy');
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self' 'unsafe-eval' 'unsafe-inline'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("img-src 'self' blob: data: https:");
      expect(csp).toContain("font-src 'self' data:");
      expect(csp).toContain("connect-src 'self' https:");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it('enforces private, no-store Cache-Control on all API routes (/api/:path*)', async () => {
      const headersConfig = await nextConfig.headers!();
      const apiRoute = headersConfig.find((r) => r.source === '/api/:path*');
      expect(apiRoute).toBeDefined();

      const headerMap = new Map(apiRoute!.headers.map((h) => [h.key, h.value]));
      const cacheControl = headerMap.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('private');
      expect(cacheControl).toContain('no-store');
      expect(cacheControl).toContain('must-revalidate');

      expect(headerMap.get('Pragma')).toBe('no-cache');
      expect(headerMap.get('Expires')).toBe('0');
    });
  });

  describe('API Route Level Cache-Control Headers', () => {
    it('returns private no-store headers on session login response', async () => {
      const req = new NextRequest('http://localhost:3000/api/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'http://localhost:3000',
        },
        body: JSON.stringify({ code: 'wrong_password_test' }),
      });

      const res = await sessionPost(req);
      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('private');
      expect(cacheControl).toContain('no-store');
    });

    it('returns private no-store headers on session inspection (GET /api/session)', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const req = new NextRequest('http://localhost:3000/api/session', {
        method: 'GET',
        headers,
      });

      const res = await sessionGet(req);
      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('private');
      expect(cacheControl).toContain('no-store');
    });

    it('returns private no-store headers on bulk session revocation', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const req = new NextRequest('http://localhost:3000/api/sessions/revoke-all', {
        method: 'POST',
        headers,
      });

      const res = await revokeAllPost(req);
      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('private');
      expect(cacheControl).toContain('no-store');
    });

    it('returns private no-store headers on auth-state version rotation', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const req = new NextRequest('http://localhost:3000/api/auth-state/rotate', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      const res = await rotateAuthStatePost(req);
      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('private');
      expect(cacheControl).toContain('no-store');
    });

    it('returns private no-store headers on achievements gallery queries', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const req = new NextRequest('http://localhost:3000/api/achievements?limit=10', {
        method: 'GET',
        headers,
      });

      const res = await getAchievements(req);
      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('private');
      expect(cacheControl).toContain('no-store');
    });
  });
});
