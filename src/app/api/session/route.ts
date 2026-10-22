import { NextResponse, type NextRequest } from 'next/server';
import { verifyOwnerAccessCode } from '@/lib/auth/crypto';
import {
  serializeSessionCookie,
  serializeClearCookie,
  extractSessionToken,
} from '@/lib/auth/cookies';
import {
  createSession,
  validateSession,
  revokeSession,
} from '@/lib/auth/session';
import { verifyInstanceAuthState } from '@/lib/auth/auth-state';
import {
  extractClientIp,
  checkRateLimit,
  recordFailedAttempt,
} from '@/lib/security/rate-limit';
import { validateCsrf } from '@/lib/security/csrf';

/**
 * POST /api/session - Secure Owner Authentication & Session Issuance
 */
export async function POST(request: NextRequest) {
  // 1. CSRF & Origin Validation
  const csrf = validateCsrf(request);
  if (!csrf.valid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 2. Extract trusted client IP
  const ip = extractClientIp(request);

  try {
    // 3. Pre-auth deployment liveness / stale instance verification
    const instanceStatus = await verifyInstanceAuthState();
    if (!instanceStatus.valid) {
      console.error('[SECURITY FATAL] Stale instance detected during login attempt: local HMAC does not match DB auth_state');
      return NextResponse.json(
        { error: 'Authentication service unavailable' },
        { status: 503 }
      );
    }

    // 4. Pre-auth rate limit check
    const limitStatus = await checkRateLimit(ip);
    if (!limitStatus.allowed) {
      return NextResponse.json(
        {
          error: 'Too many failed attempts. Please try again later.',
          retryAfter: limitStatus.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(limitStatus.retryAfterSeconds),
            'X-RateLimit-Limit': '5',
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    // 4. Parse request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    if (!body || typeof body !== 'object' || !('code' in body)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const inputCode = (body as { code: unknown }).code;

    // 5. Constant-time credential verification
    const isValid = verifyOwnerAccessCode(inputCode);

    if (!isValid) {
      // Record failed attempt in rate limiter
      const updatedLimit = await recordFailedAttempt(ip);

      if (!updatedLimit.allowed) {
        return NextResponse.json(
          {
            error: 'Too many failed attempts. Please try again later.',
            retryAfter: updatedLimit.retryAfterSeconds,
          },
          {
            status: 429,
            headers: {
              'Retry-After': String(updatedLimit.retryAfterSeconds),
              'X-RateLimit-Limit': '5',
              'X-RateLimit-Remaining': '0',
            },
          }
        );
      }

      return NextResponse.json(
        { error: 'Invalid access code' },
        {
          status: 401,
          headers: {
            'X-RateLimit-Limit': '5',
            'X-RateLimit-Remaining': String(updatedLimit.remainingAttempts),
          },
        }
      );
    }

    // 6. Valid access code: issue new session
    const { rawToken } = await createSession();
    const cookie = serializeSessionCookie(rawToken);

    const response = NextResponse.json(
      { authenticated: true },
      { status: 200 }
    );
    response.headers.append('Set-Cookie', cookie.headerValue);
    return response;
  } catch (error) {
    console.error('[AUTH ERROR] Internal failure during login:', error);
    // Strict fail-closed policy: deny login with 503
    return NextResponse.json(
      { error: 'Authentication service unavailable' },
      { status: 503 }
    );
  }
}

/**
 * GET /api/session - Inspect Caller Session Validity & Expiration Metadata
 */
export async function GET(request: NextRequest) {
  const token = extractSessionToken(request);

  if (!token) {
    return NextResponse.json(
      { authenticated: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    const result = await validateSession(token);

    if (!result.valid || !result.session) {
      const clearCookie = serializeClearCookie();
      const response = NextResponse.json(
        { authenticated: false, error: 'Unauthorized' },
        { status: 401 }
      );
      response.headers.append('Set-Cookie', clearCookie.headerValue);
      return response;
    }

    return NextResponse.json(
      {
        authenticated: true,
        session: {
          expiresAt: result.session.expiresAt.toISOString(),
          idleExpiresAt: result.session.idleExpiresAt.toISOString(),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[AUTH ERROR] Internal failure checking session:', error);
    return NextResponse.json(
      { error: 'Authentication service unavailable' },
      { status: 503 }
    );
  }
}

/**
 * DELETE /api/session - Revoke Current Device Session & Clear Cookie
 */
export async function DELETE(request: NextRequest) {
  // CSRF validation
  const csrf = validateCsrf(request);
  if (!csrf.valid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const token = extractSessionToken(request);
  const clearCookie = serializeClearCookie();

  if (!token) {
    const response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    response.headers.append('Set-Cookie', clearCookie.headerValue);
    return response;
  }

  try {
    await revokeSession(token);
    const response = NextResponse.json({ success: true }, { status: 200 });
    response.headers.append('Set-Cookie', clearCookie.headerValue);
    return response;
  } catch (error) {
    console.error('[AUTH ERROR] Internal failure revoking session:', error);
    return NextResponse.json(
      { error: 'Authentication service unavailable' },
      { status: 503 }
    );
  }
}
