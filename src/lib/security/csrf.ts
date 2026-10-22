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

    try {
      const requestOrigin = new URL(originHeader).origin;
      const expectedOrigin = new URL(env.APP_ORIGIN).origin;

      // Allow matching against APP_ORIGIN or request host URL
      const host = request.headers.get('host');
      const protocol = request.headers.get('x-forwarded-proto') ?? 'http';
      const requestHostOrigin = host ? `${protocol}://${host}` : null;

      const matchesAppOrigin = requestOrigin === expectedOrigin;
      const matchesHostOrigin = requestHostOrigin ? requestOrigin === requestHostOrigin : false;

      if (!matchesAppOrigin && !matchesHostOrigin) {
        return {
          valid: false,
          reason: `Origin mismatch: received ${requestOrigin}, expected ${expectedOrigin}`,
        };
      }
    } catch {
      return { valid: false, reason: 'Malformed origin header' };
    }
  }

  // Require either an Origin header or a custom AJAX header (X-Requested-With)
  // This guarantees browser CORS preflight enforcement prevents cross-origin HTML form submissions
  if (!originHeader && !xRequestedWith) {
    return { valid: false, reason: 'Mutating requests require either an Origin header or X-Requested-With' };
  }

  return { valid: true };
}
