import { env } from '../env';

export const PROD_COOKIE_NAME = '__Host-session';
export const DEV_COOKIE_NAME = 'dev_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds

export interface CookieOptions {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
}

/**
 * Returns cookie configuration with strict security flags for production
 * and safe fallback configuration for unencrypted HTTP localhost development.
 */
export function getSessionCookieConfig(
  nodeEnv: string = env.NODE_ENV,
  forceSecure?: boolean
): { name: string; options: Omit<CookieOptions, 'name' | 'value'> } {
  const isProduction = nodeEnv === 'production';
  const secure = forceSecure !== undefined ? forceSecure : isProduction;
  const name = secure ? PROD_COOKIE_NAME : DEV_COOKIE_NAME;

  return {
    name,
    options: {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  };
}

/**
 * Serializes a Set-Cookie header value for issuing a session token.
 */
export function serializeSessionCookie(
  token: string,
  nodeEnv: string = env.NODE_ENV,
  forceSecure?: boolean
): { name: string; value: string; headerValue: string } {
  const { name, options } = getSessionCookieConfig(nodeEnv, forceSecure);

  const parts = [
    `${name}=${token}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
  ];

  if (options.secure) {
    parts.push('Secure');
  }

  return {
    name,
    value: token,
    headerValue: parts.join('; '),
  };
}

/**
 * Serializes a Set-Cookie header value for clearing/invalidating a session cookie.
 */
export function serializeClearCookie(
  nodeEnv: string = env.NODE_ENV,
  forceSecure?: boolean
): { name: string; headerValue: string } {
  const { name, options } = getSessionCookieConfig(nodeEnv, forceSecure);

  const parts = [
    `${name}=`,
    `Path=${options.path}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Strict',
  ];

  if (options.secure) {
    parts.push('Secure');
  }

  return {
    name,
    headerValue: parts.join('; '),
  };
}

/**
 * Extracts the raw session token from request cookies.
 * Inspects both __Host-session (production) and dev_session (development fallback).
 */
export function extractSessionToken(
  cookieHeaderOrRequest: string | Headers | Request | null | undefined
): string | null {
  if (!cookieHeaderOrRequest) {
    return null;
  }

  let rawCookieString = '';

  if (typeof cookieHeaderOrRequest === 'string') {
    rawCookieString = cookieHeaderOrRequest;
  } else if ('headers' in cookieHeaderOrRequest && cookieHeaderOrRequest.headers instanceof Headers) {
    rawCookieString = cookieHeaderOrRequest.headers.get('cookie') ?? '';
  } else if (cookieHeaderOrRequest instanceof Headers) {
    rawCookieString = cookieHeaderOrRequest.get('cookie') ?? '';
  }

  if (!rawCookieString) {
    return null;
  }

  const cookies = rawCookieString.split(';').map((c) => c.trim());

  // Check production cookie first
  for (const c of cookies) {
    if (c.startsWith(`${PROD_COOKIE_NAME}=`)) {
      const val = c.substring(PROD_COOKIE_NAME.length + 1).trim();
      if (val.length > 0) return val;
    }
  }

  // Check development cookie fallback
  for (const c of cookies) {
    if (c.startsWith(`${DEV_COOKIE_NAME}=`)) {
      const val = c.substring(DEV_COOKIE_NAME.length + 1).trim();
      if (val.length > 0) return val;
    }
  }

  return null;
}
