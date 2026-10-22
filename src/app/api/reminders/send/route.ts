import { NextResponse, type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse, PRIVATE_CACHE_HEADERS } from '@/lib/auth/api-guard';
import { sendManualReminder } from '@/lib/push/sender';
import { PushEgressError } from '@/lib/push/egress';

/**
 * POST /api/reminders/send - Authenticated manual reminder trigger.
 * Protected by CSRF, durable 1-minute cooldown, idempotency replay, and SSRF egress security.
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

  const { idempotencyKey, targetSubscriptionIds } = body as {
    idempotencyKey?: unknown;
    targetSubscriptionIds?: unknown;
  };

  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return jsonError('idempotencyKey is required and must be a string', 400, 'INVALID_IDEMPOTENCY_KEY');
  }

  if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
    return jsonError(
      'idempotencyKey must be between 16 and 128 characters',
      400,
      'INVALID_IDEMPOTENCY_KEY'
    );
  }

  let targets: string[] | undefined;
  if (targetSubscriptionIds !== undefined) {
    if (!Array.isArray(targetSubscriptionIds)) {
      return jsonError('targetSubscriptionIds must be an array of UUIDs', 400, 'INVALID_TARGETS');
    }
    targets = targetSubscriptionIds.filter((t) => typeof t === 'string');
  }

  try {
    const sendResult = await sendManualReminder({
      tokenHash: auth.tokenHash,
      idempotencyKey,
      targetSubscriptionIds: targets,
    });

    return jsonResponse(
      {
        success: true,
        attemptId: sendResult.attempt.id,
        outcome: sendResult.attempt.outcome,
        cooldownSeconds: sendResult.cooldownSeconds,
        replayed: sendResult.replayed,
        results: sendResult.results,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    const error = err as Error & { code?: string; retryAfterSeconds?: number };

    // Cooldown Active -> 429 Too Many Requests with Retry-After header
    if (error.code === 'COOLDOWN_ACTIVE') {
      const retryAfter = error.retryAfterSeconds || 60;
      return NextResponse.json(
        {
          error: error.message,
          code: 'COOLDOWN_ACTIVE',
          retryAfter,
          details: { retryAfter },
        },
        {
          status: 429,
          headers: {
            ...PRIVATE_CACHE_HEADERS,
            'Retry-After': String(retryAfter),
          },
        }
      );
    }

    // No Active Targets -> 400 Bad Request
    if (error.code === 'NO_ACTIVE_TARGETS') {
      return jsonError(error.message, 400, 'NO_ACTIVE_TARGETS');
    }

    // Egress Violations (SSRF, Port, Origin, Protocol) -> 400 Bad Request
    if (error instanceof PushEgressError || error.code === 'SSRF_DETECTED' || error.code === 'EGRESS_VIOLATION') {
      return jsonError(error.message, 400, error.code || 'EGRESS_VIOLATION');
    }

    console.error('[REMINDER SEND ERROR]', err);
    return jsonError(
      error.message || 'Internal failure during push reminder dispatch',
      500,
      error.code || 'INTERNAL_ERROR'
    );
  }
}
