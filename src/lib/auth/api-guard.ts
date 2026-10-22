import { NextResponse, type NextRequest } from 'next/server';
import { extractSessionToken, serializeClearCookie } from './cookies';
import { validateSession, SessionValidationResult } from './session';
import { validateCsrf } from '../security/csrf';
import { Session } from '../db/schema';
import { hashSessionToken } from './crypto';

export const PRIVATE_CACHE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
};

export interface AuthContext {
  session: Session;
  tokenHash: string;
}

export function jsonError(
  message: string,
  statusCode: number = 400,
  code: string = 'ERROR',
  details?: unknown
): NextResponse {
  return NextResponse.json(
    {
      error: message,
      code,
      ...(details ? { details } : {}),
    },
    {
      status: statusCode,
      headers: PRIVATE_CACHE_HEADERS,
    }
  );
}

export function jsonResponse<T>(data: T, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(PRIVATE_CACHE_HEADERS)) {
    headers.set(k, v);
  }

  return NextResponse.json(data, {
    ...init,
    headers,
  });
}

/**
 * Authenticates request, checks CSRF if mutating, and returns active AuthContext or an error response.
 */
export async function authenticateApiRequest(
  request: NextRequest,
  options: { checkCsrf?: boolean } = {}
): Promise<{ auth: AuthContext; errorResponse: null } | { auth: null; errorResponse: NextResponse }> {
  const method = request.method.toUpperCase();
  const shouldCheckCsrf = options.checkCsrf ?? (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS');

  if (shouldCheckCsrf) {
    const csrf = validateCsrf(request);
    if (!csrf.valid) {
      return {
        auth: null,
        errorResponse: jsonError(csrf.reason || 'Forbidden: CSRF check failed', 403, 'CSRF_FAILED'),
      };
    }
  }

  const token = extractSessionToken(request);
  if (!token) {
    return {
      auth: null,
      errorResponse: jsonError('Unauthorized: Missing session token', 401, 'UNAUTHENTICATED'),
    };
  }

  try {
    const result: SessionValidationResult = await validateSession(token);
    if (!result.valid || !result.session) {
      const clearCookie = serializeClearCookie();
      const res = jsonError('Unauthorized: Invalid or expired session', 401, 'UNAUTHENTICATED');
      res.headers.append('Set-Cookie', clearCookie.headerValue);
      return { auth: null, errorResponse: res };
    }

    const tokenHash = hashSessionToken(token);
    return {
      auth: {
        session: result.session,
        tokenHash,
      },
      errorResponse: null,
    };
  } catch (err) {
    console.error('[API AUTH ERROR] Failed to validate session:', err);
    return {
      auth: null,
      errorResponse: jsonError('Authentication service unavailable', 503, 'DATABASE_OUTAGE'),
    };
  }
}
