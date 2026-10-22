import { NextResponse, type NextRequest } from 'next/server';
import { extractSessionToken, serializeClearCookie } from '@/lib/auth/cookies';
import { validateSession } from '@/lib/auth/session';
import { rotateAuthState } from '@/lib/auth/auth-state';
import { validateCsrf } from '@/lib/security/csrf';

/**
 * POST /api/auth-state/rotate - Domain-Separated Version Rotation & Global Invalidation
 */
export async function POST(request: NextRequest) {
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
    const validation = await validateSession(token);
    if (!validation.valid) {
      const response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      response.headers.append('Set-Cookie', clearCookie.headerValue);
      return response;
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // optional body
    }

    const newVersion = typeof body.newVersion === 'string' ? body.newVersion : undefined;
    const result = await rotateAuthState({
      newVersion,
      metadata: { reason: 'api_manual_rotation' },
    });

    const response = NextResponse.json(
      {
        success: true,
        newVersion: result.newVersion,
        rotatedAt: result.rotatedAt.toISOString(),
        revokedSessionCount: result.revokedSessionCount,
      },
      { status: 200 }
    );
    response.headers.append('Set-Cookie', clearCookie.headerValue);
    return response;
  } catch (error) {
    console.error('[AUTH ERROR] Internal failure rotating auth_state:', error);
    return NextResponse.json(
      { error: 'Authentication service unavailable' },
      { status: 503 }
    );
  }
}
