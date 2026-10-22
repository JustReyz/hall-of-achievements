import { env } from '../env';

export interface CsrfValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates request Origin and security headers on mutating HTTP requests.
 */
export function validateCsrf(request: Request): CsrfValidationResult {
  const method = request.method.toUpperCase();

  // Safe HTTP methods do not require CSRF validation
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return { valid: true };
  }

  const originHeader = request.headers.get('origin');
  const secFetchSite = request.headers.get('sec-fetch-site');
  const xRequestedWith = request.headers.get('x-requested-with');

  // Check Sec-Fetch-Site if provided by modern browsers
  if (secFetchSite === 'cross-site') {
    return { valid: false, reason: 'Cross-site request blocked by Sec-Fetch-Site' };
  }

  // Verify Origin header
  if (originHeader) {
    if (originHeader === 'null') {
      return { valid: false, reason: 'Null origin is disallowed on mutating routes' };
    }

    let requestOrigin: string;
    try {
      requestOrigin = new URL(originHeader).origin;
    } catch {
      return { valid: false, reason: 'Malformed origin header' };
    }

    try {
      // 1. Match against configured APP_ORIGIN
      let expectedOrigin: string | null = null;
      try {
        const rawAppOrigin = env.APP_ORIGIN;
        if (rawAppOrigin) {
          const withProto =
            rawAppOrigin.startsWith('http://') || rawAppOrigin.startsWith('https://')
              ? rawAppOrigin
              : `https://${rawAppOrigin}`;
          expectedOrigin = new URL(withProto).origin;
        }
      } catch (err) {
        console.warn('[SECURITY WARNING] Could not parse APP_ORIGIN in CSRF check:', err);
      }

      // 2. Match against actual incoming request URL
      let requestUrlOrigin: string | null = null;
      try {
        requestUrlOrigin = new URL(request.url).origin;
      } catch {
        // ignore invalid request URL
      }

      // 3. Match against Host / X-Forwarded-Host headers
      const forwardedHost = request.headers.get('x-forwarded-host');
      const host = forwardedHost ?? request.headers.get('host');
      const protocol = request.headers.get('x-forwarded-proto') ?? 'https';
      const requestHostOrigin = host ? `${protocol}://${host}` : null;

      const matchesAppOrigin = expectedOrigin ? requestOrigin === expectedOrigin : false;
      const matchesUrlOrigin = requestUrlOrigin ? requestOrigin === requestUrlOrigin : false;
      const matchesHostOrigin = requestHostOrigin ? requestOrigin === requestHostOrigin : false;

      if (!matchesAppOrigin && !matchesUrlOrigin && !matchesHostOrigin) {
        return {
          valid: false,
          reason: `Origin mismatch: received ${requestOrigin}, expected ${expectedOrigin ?? requestHostOrigin ?? requestUrlOrigin}`,
        };
      }
    } catch (err) {
      console.error('[CSRF ERROR] Unexpected error during origin verification:', err);
      return { valid: false, reason: 'Origin verification failed' };
    }
  }

  // Require either an Origin header or a custom AJAX header (X-Requested-With)
  // This guarantees browser CORS preflight enforcement prevents cross-origin HTML form submissions
  if (!originHeader && !xRequestedWith) {
    return { valid: false, reason: 'Mutating requests require either an Origin header or X-Requested-With' };
  }

  return { valid: true };
}
