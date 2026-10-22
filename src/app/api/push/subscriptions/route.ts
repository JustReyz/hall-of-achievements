import { type NextRequest } from 'next/server';
import { eq, desc, sql } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { pushSubscriptions } from '@/lib/db/schema';
import { validatePushEndpoint } from '@/lib/push/egress';

const MAX_ACTIVE_DEVICES = 5;

/**
 * GET /api/push/subscriptions - List active subscriptions for authenticated owner.
 * Cryptographic secrets (p256dh, auth) and raw endpoints are completely omitted from responses.
 */
export async function GET(request: NextRequest) {
  const { auth, errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  try {
    const db = await getDb();
    const subs = await db
      .select({
        id: pushSubscriptions.id,
        userAgent: pushSubscriptions.userAgent,
        status: pushSubscriptions.status,
        createdAt: pushSubscriptions.createdAt,
        tokenHash: pushSubscriptions.tokenHash,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.status, 'active'))
      .orderBy(desc(pushSubscriptions.createdAt));

    const sanitized = subs.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      isCurrentDevice: s.tokenHash === auth.tokenHash,
    }));

    return jsonResponse({ subscriptions: sanitized });
  } catch (err) {
    console.error('[PUSH SUBSCRIPTIONS GET ERROR]', err);
    return jsonError('Database outage: failed to list subscriptions', 503, 'DATABASE_OUTAGE');
  }
}

/**
 * POST /api/push/subscriptions - Register or update a Web Push subscription.
 * SENDS ZERO PUSH NOTIFICATIONS.
 */
export async function POST(request: NextRequest) {
  const { auth, errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body', 400, 'INVALID_JSON');
  }

  if (!body || typeof body !== 'object') {
    return jsonError('Request body must be a JSON object', 400, 'INVALID_BODY');
  }

  const { endpoint, keys, userAgent } = body as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    userAgent?: unknown;
  };

  if (!endpoint || typeof endpoint !== 'string') {
    return jsonError('Subscription endpoint is required', 400, 'INVALID_ENDPOINT');
  }

  if (!keys || typeof keys !== 'object' || !keys.p256dh || !keys.auth) {
    return jsonError('Subscription keys (p256dh and auth) are required', 400, 'INVALID_KEYS');
  }

  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return jsonError('Subscription keys must be strings', 400, 'INVALID_KEYS');
  }

  // 1. Egress security verification: HTTPS, Port 443, Allowlist, No userinfo, Anti-SSRF
  const egressResult = await validatePushEndpoint(endpoint);
  if (!egressResult.valid) {
    return jsonError(
      egressResult.error || 'Push endpoint failed egress validation',
      400,
      egressResult.code || 'EGRESS_VIOLATION'
    );
  }

  try {
    const db = await getDb();

    // 2. Check if endpoint already exists in database
    const [existing] = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .limit(1);

    if (existing) {
      // Re-activate and update existing subscription
      await db
        .update(pushSubscriptions)
        .set({
          p256dh: keys.p256dh,
          auth: keys.auth,
          tokenHash: auth.tokenHash,
          userAgent: typeof userAgent === 'string' ? userAgent : existing.userAgent,
          status: 'active',
          updatedAt: new Date(),
        })
        .where(eq(pushSubscriptions.id, existing.id));

      return jsonResponse(
        {
          success: true,
          subscription: {
            id: existing.id,
            status: 'active',
          },
        },
        { status: 200 }
      );
    }

    // 3. Check 5-device active fleet limit
    const [activeCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.status, 'active'));

    const currentCount = Number(activeCountRow?.count ?? 0);
    if (currentCount >= MAX_ACTIVE_DEVICES) {
      return jsonError(
        `Fleet limit reached: Maximum ${MAX_ACTIVE_DEVICES} active device subscriptions allowed.`,
        409,
        'MAX_SUBSCRIPTIONS_EXCEEDED'
      );
    }

    // 4. Insert new subscription
    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(pushSubscriptions).values({
      id,
      tokenHash: auth.tokenHash,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    return jsonResponse(
      {
        success: true,
        subscription: {
          id,
          status: 'active',
        },
      },
      { status: 201 }
    );
  } catch (err) {
    console.error('[PUSH SUBSCRIPTIONS POST ERROR]', err);
    return jsonError('Database failure saving subscription', 503, 'DATABASE_OUTAGE');
  }
}

/**
 * DELETE /api/push/subscriptions - Deactivate push subscription for this device or by ID.
 * SENDS ZERO PUSH NOTIFICATIONS.
 */
export async function DELETE(request: NextRequest) {
  const { auth, errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  let targetId: string | null = null;
  let targetEndpoint: string | null = null;

  try {
    const body = await request.json().catch(() => null);
    if (body && typeof body === 'object') {
      if ('id' in body && typeof body.id === 'string') targetId = body.id;
      if ('endpoint' in body && typeof body.endpoint === 'string') targetEndpoint = body.endpoint;
    }
  } catch {
    // Ignore JSON parse failure for DELETE with no body
  }

  // Check URL search params as fallback
  const url = new URL(request.url);
  if (!targetId && url.searchParams.get('id')) {
    targetId = url.searchParams.get('id');
  }

  try {
    const db = await getDb();
    const now = new Date();

    if (targetId) {
      await db
        .update(pushSubscriptions)
        .set({ status: 'disabled', updatedAt: now })
        .where(eq(pushSubscriptions.id, targetId));
    } else if (targetEndpoint) {
      await db
        .update(pushSubscriptions)
        .set({ status: 'disabled', updatedAt: now })
        .where(eq(pushSubscriptions.endpoint, targetEndpoint));
    } else {
      // Default: disable all subscriptions linked to current session's tokenHash
      await db
        .update(pushSubscriptions)
        .set({ status: 'disabled', updatedAt: now })
        .where(eq(pushSubscriptions.tokenHash, auth.tokenHash));
    }

    return jsonResponse({
      success: true,
      message: 'Subscription disabled successfully',
    });
  } catch (err) {
    console.error('[PUSH SUBSCRIPTIONS DELETE ERROR]', err);
    return jsonError('Database failure disabling subscription', 503, 'DATABASE_OUTAGE');
  }
}
