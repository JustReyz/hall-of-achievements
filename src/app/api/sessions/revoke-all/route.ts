import { NextResponse, type NextRequest } from 'next/server';
import { extractSessionToken, serializeClearCookie } from '@/lib/auth/cookies';
import { validateSession, revokeAllSessions } from '@/lib/auth/session';
import { validateCsrf } from '@/lib/security/csrf';

/**
 * POST /api/sessions/revoke-all - Bulk Revoke All Active Sessions Across Devices
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

    const revokedCount = await revokeAllSessions();

    const response = NextResponse.json(
      { success: true, revokedCount },
      { status: 200 }
    );
    response.headers.append('Set-Cookie', clearCookie.headerValue);
    return response;
  } catch (error) {
    console.error('[AUTH ERROR] Internal failure revoking all sessions:', error);
    return NextResponse.json(
      { error: 'Authentication service unavailable' },
      { status: 503 }
    );
  }
}
