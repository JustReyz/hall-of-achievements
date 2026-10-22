import { describe, it, expect } from 'vitest';
import {
  getSessionCookieConfig,
  serializeSessionCookie,
  serializeClearCookie,
  extractSessionToken,
  PROD_COOKIE_NAME,
  DEV_COOKIE_NAME,
} from '@/lib/auth/cookies';

describe('Unit: Cookie Management & Secure Dispatch', () => {
  const dummyToken = 'dGVzdF90b2tlbl8yNTZfYml0X2VudHJvcHlfZXhhbXBsZQ';

  describe('getSessionCookieConfig', () => {
    it('enforces __Host- prefix and strict flags in production', () => {
      const config = getSessionCookieConfig('production');

      expect(config.name).toBe(PROD_COOKIE_NAME);
      expect(config.options.httpOnly).toBe(true);
      expect(config.options.secure).toBe(true);
      expect(config.options.sameSite).toBe('strict');
      expect(config.options.path).toBe('/');
      expect(config.options.maxAge).toBe(604800); // 7 days in seconds
    });

    it('falls back to dev_session with secure=false in development', () => {
      const config = getSessionCookieConfig('development');

      expect(config.name).toBe(DEV_COOKIE_NAME);
      expect(config.options.httpOnly).toBe(true);
      expect(config.options.secure).toBe(false);
      expect(config.options.sameSite).toBe('strict');
      expect(config.options.path).toBe('/');
    });
  });

  describe('serializeSessionCookie', () => {
    it('serializes complete Set-Cookie header with __Host- prefix in production', () => {
      const { name, headerValue } = serializeSessionCookie(dummyToken, 'production');

      expect(name).toBe(PROD_COOKIE_NAME);
      expect(headerValue).toContain(`${PROD_COOKIE_NAME}=${dummyToken}`);
      expect(headerValue).toContain('Path=/');
      expect(headerValue).toContain('HttpOnly');
      expect(headerValue).toContain('SameSite=Strict');
      expect(headerValue).toContain('Secure');
      expect(headerValue).toContain('Max-Age=604800');
      // RFC 6265bis: __Host- cookies must NOT include Domain attribute
      expect(headerValue).not.toContain('Domain');
    });

    it('serializes development cookie without Secure attribute for plaintext localhost', () => {
      const { name, headerValue } = serializeSessionCookie(dummyToken, 'development');

      expect(name).toBe(DEV_COOKIE_NAME);
      expect(headerValue).toContain(`${DEV_COOKIE_NAME}=${dummyToken}`);
      expect(headerValue).toContain('Path=/');
      expect(headerValue).toContain('HttpOnly');
      expect(headerValue).toContain('SameSite=Strict');
      expect(headerValue).not.toContain('Secure');
      expect(headerValue).not.toContain('Domain');
    });
  });

  describe('serializeClearCookie', () => {
    it('serializes cookie with Max-Age=0 and expired timestamp to invalidate session', () => {
      const { name, headerValue } = serializeClearCookie('production');

      expect(name).toBe(PROD_COOKIE_NAME);
      expect(headerValue).toContain(`${PROD_COOKIE_NAME}=`);
      expect(headerValue).toContain('Max-Age=0');
      expect(headerValue).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      expect(headerValue).toContain('Path=/');
      expect(headerValue).toContain('HttpOnly');
    });
  });

  describe('extractSessionToken', () => {
    it('extracts token from production __Host-session cookie', () => {
      const cookieHeader = `theme=dark; ${PROD_COOKIE_NAME}=${dummyToken}; other=123`;
      expect(extractSessionToken(cookieHeader)).toBe(dummyToken);
    });

    it('extracts token from development dev_session cookie fallback', () => {
      const cookieHeader = `${DEV_COOKIE_NAME}=${dummyToken}`;
      expect(extractSessionToken(cookieHeader)).toBe(dummyToken);
    });

    it('extracts token from Headers instance', () => {
      const headers = new Headers();
      headers.set('cookie', `${PROD_COOKIE_NAME}=${dummyToken}`);
      expect(extractSessionToken(headers)).toBe(dummyToken);
    });

    it('extracts token from Request instance', () => {
      const request = new Request('http://localhost:3000/api/session', {
        headers: { cookie: `${PROD_COOKIE_NAME}=${dummyToken}` },
      });
      expect(extractSessionToken(request)).toBe(dummyToken);
    });

    it('returns null when cookie is missing or empty', () => {
      expect(extractSessionToken(null)).toBeNull();
      expect(extractSessionToken('')).toBeNull();
      expect(extractSessionToken('other_cookie=value')).toBeNull();
    });
  });
});
