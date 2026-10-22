import webpush from 'web-push';
import { eq, gt, desc, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  pushSubscriptions,
  reminderAttempts,
  type ReminderAttempt,
} from '@/lib/db/schema';
import { env } from '@/lib/env';
import { assertPushEndpointSafe, createSafePushAgent } from './egress';

let testVapidKeys: { publicKey: string; privateKey: string } | null = null;

export function setTestVapidKeys(keys: { publicKey: string; privateKey: string } | null) {
  testVapidKeys = keys;
}

/**
 * Retrieves VAPID key configuration: uses environment variables in production,
 * and generates / caches deterministic fallback keys in test/development mode.
 */
export function getVapidKeys(): { publicKey: string; privateKey: string; subject: string } {
  const pub = env.VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT || process.env.VAPID_SUBJECT || 'mailto:admin@hall-of-achievements.local';

  if (pub && priv) {
    return { publicKey: pub, privateKey: priv, subject };
  }

  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
    if (!testVapidKeys) {
      testVapidKeys = webpush.generateVAPIDKeys();
    }
    return { ...testVapidKeys, subject };
  }

  throw new Error('VAPID keys not configured in production environment');
}

/**
 * Checks if a reminder attempt has occurred within the last 60 seconds across all serverless instances.
 */
export async function checkReminderCooldown(): Promise<{
  cooldownActive: boolean;
  retryAfterSeconds: number;
  recentAttempt?: ReminderAttempt | undefined;
}> {
  const db = await getDb();
  const sixtySecondsAgo = new Date(Date.now() - 60_000);

  const [recentAttempt] = await db
    .select()
    .from(reminderAttempts)
    .where(gt(reminderAttempts.attemptedAt, sixtySecondsAgo))
    .orderBy(desc(reminderAttempts.attemptedAt))
    .limit(1);

  if (recentAttempt) {
    const elapsedMs = Date.now() - recentAttempt.attemptedAt.getTime();
    const retryAfterSeconds = Math.max(1, Math.ceil((60_000 - elapsedMs) / 1000));
    return {
      cooldownActive: true,
      retryAfterSeconds,
      recentAttempt,
    };
  }

  return {
    cooldownActive: false,
    retryAfterSeconds: 0,
  };
}

/**
 * Queries reminder_attempts for a previously submitted idempotency key.
 */
export async function findExistingAttemptByIdempotencyKey(
  idempotencyKey: string
): Promise<ReminderAttempt | null> {
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(reminderAttempts)
    .where(eq(reminderAttempts.idempotencyKey, idempotencyKey))
    .limit(1);

  return existing || null;
}

export interface TargetDispatchResult {
  subscriptionId: string;
  status: 'accepted' | 'rejected' | 'unknown';
  statusCode?: number | undefined;
  reason?: string | undefined;
}

export interface SendManualReminderParams {
  tokenHash: string;
  idempotencyKey: string;
  targetSubscriptionIds?: string[] | undefined;
}

export interface SendManualReminderResponse {
  attempt: ReminderAttempt;
  results: TargetDispatchResult[];
  replayed: boolean;
  cooldownSeconds: number;
}

/**
 * Strictly generic notification payload containing ZERO secrets, titles, notes, or signed URLs.
 */
export const GENERIC_REMINDER_PAYLOAD = {
  title: 'Hall of Achievements',
  body: 'New reminder from Hall of Achievements',
  url: '/',
};

/**
 * Deterministic 64-bit advisory lock keys for manual reminder dispatch synchronization.
 * Uses two 32-bit signed integers:
 * KEY1: 0x484F41 (4738881)    -> "HOA" (Hall of Achievements)
 * KEY2: 0x52454D4E (1380273486) -> "REMN" (Reminder)
 */
export const REMINDER_COOLDOWN_LOCK_KEY1 = 4738881;
export const REMINDER_COOLDOWN_LOCK_KEY2 = 1380273486;

/**
 * Dispatches manual push reminder with atomic cooldown check, idempotency replay,
 * egress security validation, generic lockscreen payload, and 60-second TTL.
 */
export async function sendManualReminder(
  params: SendManualReminderParams
): Promise<SendManualReminderResponse> {
  const db = await getDb();

  // 1. Fast-Path Idempotency Check: return stored attempt record if already executed
  const existing = await findExistingAttemptByIdempotencyKey(params.idempotencyKey);
  if (existing) {
    const cachedResults = (existing.details as { results?: TargetDispatchResult[] })?.results || [];
    return {
      attempt: existing,
      results: cachedResults,
      replayed: true,
      cooldownSeconds: 60,
    };
  }

  // 2. Atomic Critical Section: Lock, Idempotency Re-check, Cooldown Check, Target Selection & Attempt Pre-commit
  const attemptId = crypto.randomUUID();
  const now = new Date();
  const sixtySecondsAgo = new Date(now.getTime() - 60_000);

  const reservation = await db.transaction(async (tx) => {
    // 2.1 Acquire transaction-scoped advisory lock across cluster
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${REMINDER_COOLDOWN_LOCK_KEY1}, ${REMINDER_COOLDOWN_LOCK_KEY2})`
    );

    // 2.2 Re-check idempotency under lock (in case a concurrent request with same key committed while waiting)
    const [lockedExisting] = await tx
      .select()
      .from(reminderAttempts)
      .where(eq(reminderAttempts.idempotencyKey, params.idempotencyKey))
      .limit(1);

    if (lockedExisting) {
      return { replayed: true as const, existing: lockedExisting };
    }

    // 2.3 Atomic Cooldown check under lock across fleet
    const [recentAttempt] = await tx
      .select()
      .from(reminderAttempts)
      .where(gt(reminderAttempts.attemptedAt, sixtySecondsAgo))
      .orderBy(desc(reminderAttempts.attemptedAt))
      .limit(1);

    if (recentAttempt) {
      const elapsedMs = now.getTime() - recentAttempt.attemptedAt.getTime();
      const retryAfterSeconds = Math.max(1, Math.ceil((60_000 - elapsedMs) / 1000));
      const error = new Error('Reminder cooldown active. Please wait 60 seconds between manual sends.');
      (error as Error & { code: string; retryAfterSeconds: number }).code = 'COOLDOWN_ACTIVE';
      (error as Error & { code: string; retryAfterSeconds: number }).retryAfterSeconds = retryAfterSeconds;
      throw error;
    }

    // 2.4 Resolve active target subscriptions
    const targetRows = await tx
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.status, 'active'));

    let activeTargets = targetRows;
    if (params.targetSubscriptionIds && params.targetSubscriptionIds.length > 0) {
      const allowedIds = new Set(params.targetSubscriptionIds);
      activeTargets = activeTargets.filter((sub) => allowedIds.has(sub.id));
    }

    if (activeTargets.length === 0) {
      const error = new Error('No active target subscriptions available.');
      (error as Error & { code: string }).code = 'NO_ACTIVE_TARGETS';
      throw error;
    }

    // Cap at 5 targets maximum per fleet policy
    activeTargets = activeTargets.slice(0, 5);
    const targetIds = activeTargets.map((t) => t.id);

    // 2.5 Pre-commit Attempt in Database (At-most-once reliability guarantee)
    const [insertedAttempt] = await tx
      .insert(reminderAttempts)
      .values({
        id: attemptId,
        idempotencyKey: params.idempotencyKey,
        tokenHash: params.tokenHash,
        targetIds,
        outcome: 'in_progress',
        details: { results: [] },
        attemptedAt: now,
        createdAt: now,
      })
      .returning();

    if (!insertedAttempt) {
      throw new Error('Failed to pre-commit reminder attempt');
    }

    return {
      replayed: false as const,
      attempt: insertedAttempt,
      targets: activeTargets,
    };
  });

  // Handle replayed branch if concurrent request committed while waiting for lock
  if (reservation.replayed) {
    const cachedResults = (reservation.existing.details as { results?: TargetDispatchResult[] })?.results || [];
    return {
      attempt: reservation.existing,
      results: cachedResults,
      replayed: true,
      cooldownSeconds: 60,
    };
  }

  const activeTargets = reservation.targets;

  // 3. Outbound Web Push Dispatching (EXECUTED OUTSIDE DATABASE TRANSACTION)
  const vapid = getVapidKeys();
  const payloadString = JSON.stringify(GENERIC_REMINDER_PAYLOAD);
  const results: TargetDispatchResult[] = [];

  for (const sub of activeTargets) {
    try {
      // Egress Security Check: HTTPS, Port 443, Allowlist, No userinfo, Anti-SSRF
      const { url, resolvedIps } = await assertPushEndpointSafe(sub.endpoint);
      const pinnedIp = resolvedIps[0] || '127.0.0.1';
      const isHttp = url.protocol === 'http:';
      const safeAgent = createSafePushAgent(pinnedIp, url.hostname, isHttp);

      const pushRes = await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        },
        payloadString,
        {
          TTL: 60,
          urgency: 'normal',
          vapidDetails: {
            subject: vapid.subject,
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
          agent: safeAgent as unknown as undefined,
        }
      );

      results.push({
        subscriptionId: sub.id,
        status: 'accepted',
        statusCode: pushRes.statusCode || 201,
      });
    } catch (pushErr: unknown) {
      const errorObj = pushErr as { statusCode?: number; status?: number; message?: string };
      const statusCode = errorObj.statusCode || errorObj.status || 0;

      // Inactive Subscription Lifecycle: 404/410 deactivates subscription
      if (statusCode === 404 || statusCode === 410) {
        await db
          .update(pushSubscriptions)
          .set({ status: 'disabled', updatedAt: new Date() })
          .where(eq(pushSubscriptions.id, sub.id));

        results.push({
          subscriptionId: sub.id,
          status: 'rejected',
          statusCode,
          reason: 'subscription_expired_or_unregistered',
        });
      } else {
        const item: TargetDispatchResult = {
          subscriptionId: sub.id,
          status: 'rejected',
          reason: errorObj.message || 'Push dispatch failed',
        };
        if (statusCode > 0) {
          item.statusCode = statusCode;
        }
        results.push(item);
      }
    }
  }

  // 6. Finalize Attempt Record in Database
  const hasAccepted = results.some((r) => r.status === 'accepted');
  const hasRejected = results.some((r) => r.status === 'rejected');
  const finalOutcome = hasAccepted && !hasRejected ? 'accepted' : hasAccepted ? 'partial' : 'rejected';

  await db
    .update(reminderAttempts)
    .set({
      outcome: finalOutcome,
      details: { results },
    })
    .where(eq(reminderAttempts.id, attemptId));

  const [finalAttempt] = await db
    .select()
    .from(reminderAttempts)
    .where(eq(reminderAttempts.id, attemptId))
    .limit(1);

  if (!finalAttempt) {
    throw new Error('Failed to retrieve committed reminder attempt');
  }

  return {
    attempt: finalAttempt,
    results,
    replayed: false,
    cooldownSeconds: 60,
  };
}
