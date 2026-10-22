import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import webpush from 'web-push';
import { resetDatabase, getDb } from '@/lib/db';
import {
  pushSubscriptions,
  reminderAttempts,
} from '@/lib/db/schema';
import {
  getVapidKeys,
  checkReminderCooldown,
  findExistingAttemptByIdempotencyKey,
  sendManualReminder,
  GENERIC_REMINDER_PAYLOAD,
} from '@/lib/push/sender';
import { setAllowedTestOrigin } from '@/lib/push/egress';

describe('Unit: Web Push Sender & Cooldown Engine', () => {
  beforeEach(async () => {
    await resetDatabase();
    setAllowedTestOrigin('https://fcm.googleapis.com');
  });

  afterEach(() => {
    setAllowedTestOrigin(null);
    vi.restoreAllMocks();
  });

  describe('VAPID Configuration & Fallback Keys', () => {
    it('provides valid VAPID keys in test mode with subject', () => {
      const keys = getVapidKeys();
      expect(keys.publicKey).toBeDefined();
      expect(typeof keys.publicKey).toBe('string');
      expect(keys.publicKey.length).toBeGreaterThan(60);
      expect(keys.privateKey).toBeDefined();
      expect(keys.subject).toMatch(/^(mailto:|https:)/);
    });
  });

  describe('Generic Lock-Screen Content Privacy Rules (AC6)', () => {
    it('guarantees lock-screen copy contains zero art metadata or secrets', () => {
      expect(GENERIC_REMINDER_PAYLOAD.title).toBe('Hall of Achievements');
      expect(GENERIC_REMINDER_PAYLOAD.body).toBe('New reminder from Hall of Achievements');
      expect(GENERIC_REMINDER_PAYLOAD.url).toBe('/');

      // Verify zero leakage of art, notes, tokens, or signed URLs
      const payloadString = JSON.stringify(GENERIC_REMINDER_PAYLOAD);
      expect(payloadString).not.toContain('token');
      expect(payloadString).not.toContain('secret');
      expect(payloadString).not.toContain('download');
      expect(payloadString).not.toContain('signed');
      expect(payloadString).not.toContain('access_code');
    });
  });

  describe('60-Second Cooldown Persistence & Query', () => {
    it('returns cooldownActive: false when no prior attempts exist', async () => {
      const status = await checkReminderCooldown();
      expect(status.cooldownActive).toBe(false);
      expect(status.retryAfterSeconds).toBe(0);
      expect(status.recentAttempt).toBeUndefined();
    });

    it('returns cooldownActive: true with correct retryAfter when attempt is within 60 seconds', async () => {
      const db = await getDb();
      const attemptId = crypto.randomUUID();
      const twentySecondsAgo = new Date(Date.now() - 20_000);

      await db.insert(reminderAttempts).values({
        id: attemptId,
        idempotencyKey: 'idemp-recent-test-key-1',
        tokenHash: 'test_token_hash_value',
        targetIds: [],
        outcome: 'accepted',
        details: {},
        attemptedAt: twentySecondsAgo,
        createdAt: twentySecondsAgo,
      });

      const status = await checkReminderCooldown();
      expect(status.cooldownActive).toBe(true);
      expect(status.retryAfterSeconds).toBeGreaterThanOrEqual(35);
      expect(status.retryAfterSeconds).toBeLessThanOrEqual(41);
      expect(status.recentAttempt).toBeDefined();
      expect(status.recentAttempt?.id).toBe(attemptId);
    });

    it('returns cooldownActive: false when prior attempt is older than 60 seconds', async () => {
      const db = await getDb();
      const seventySecondsAgo = new Date(Date.now() - 70_000);

      await db.insert(reminderAttempts).values({
        id: crypto.randomUUID(),
        idempotencyKey: 'idemp-old-test-key-1',
        tokenHash: 'test_token_hash_value',
        targetIds: [],
        outcome: 'accepted',
        details: {},
        attemptedAt: seventySecondsAgo,
        createdAt: seventySecondsAgo,
      });

      const status = await checkReminderCooldown();
      expect(status.cooldownActive).toBe(false);
      expect(status.retryAfterSeconds).toBe(0);
    });
  });

  describe('Idempotency Lookup', () => {
    it('returns null for an unused idempotency key', async () => {
      const attempt = await findExistingAttemptByIdempotencyKey('unused-idempotency-key-xyz');
      expect(attempt).toBeNull();
    });

    it('returns existing record when idempotency key was previously committed', async () => {
      const db = await getDb();
      const key = 'existing-idempotency-key-abc';
      const id = crypto.randomUUID();

      await db.insert(reminderAttempts).values({
        id,
        idempotencyKey: key,
        tokenHash: 'hash-abc',
        targetIds: ['sub-1'],
        outcome: 'accepted',
        details: { results: [{ subscriptionId: 'sub-1', status: 'accepted' }] },
      });

      const found = await findExistingAttemptByIdempotencyKey(key);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(id);
      expect(found?.outcome).toBe('accepted');
    });
  });

  describe('Outbound Push Dispatch & 404/410 Deactivation (AC8)', () => {
    it('enforces 60-second TTL on outbound push request', async () => {
      const db = await getDb();
      const subId = crypto.randomUUID();

      // Setup active subscription
      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash: 'active_token_hash',
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
        p256dh: 'BNcRnp1234567890abcdef...',
        auth: 'authSecret123456...',
        status: 'active',
      });

      // Mock webpush.sendNotification
      const sendSpy = vi.spyOn(webpush, 'sendNotification').mockResolvedValueOnce({
        statusCode: 201,
        headers: {},
        body: '',
      });

      const res = await sendManualReminder({
        tokenHash: 'active_token_hash',
        idempotencyKey: 'fresh-idempotency-key-ttl-test',
        targetSubscriptionIds: [subId],
      });

      expect(res.attempt.outcome).toBe('accepted');
      expect(sendSpy).toHaveBeenCalledOnce();

      // Inspect webpush options passed
      const optionsPassed = sendSpy.mock.calls[0]?.[2] as { TTL?: number };
      expect(optionsPassed.TTL).toBe(60);
    });

    it('marks subscription disabled upon provider HTTP 410 Gone response', async () => {
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash: 'active_token_hash',
        endpoint: 'https://fcm.googleapis.com/fcm/send/expired-device',
        p256dh: 'BNcRnp1234567890abcdef...',
        auth: 'authSecret123456...',
        status: 'active',
      });

      // Mock provider returning 410 Gone (user revoked notifications in browser)
      const goneError = new Error('Subscription has expired');
      (goneError as unknown as { statusCode: number }).statusCode = 410;
      vi.spyOn(webpush, 'sendNotification').mockRejectedValueOnce(goneError);

      const res = await sendManualReminder({
        tokenHash: 'active_token_hash',
        idempotencyKey: 'idemp-410-test-key-1',
        targetSubscriptionIds: [subId],
      });

      expect(res.attempt.outcome).toBe('rejected');
      expect(res.results[0]?.status).toBe('rejected');
      expect(res.results[0]?.statusCode).toBe(410);

      // Verify subscription status in database transitioned to 'disabled'
      const [directSub] = await db.select().from(pushSubscriptions);
      expect(directSub?.status).toBe('disabled');
    });

    it('marks subscription disabled upon provider HTTP 404 Not Found response', async () => {
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash: 'active_token_hash',
        endpoint: 'https://fcm.googleapis.com/fcm/send/not-found-device',
        p256dh: 'BNcRnp1234567890abcdef...',
        auth: 'authSecret123456...',
        status: 'active',
      });

      // Mock provider returning 404
      const notFoundError = new Error('Not Found');
      (notFoundError as unknown as { statusCode: number }).statusCode = 404;
      vi.spyOn(webpush, 'sendNotification').mockRejectedValueOnce(notFoundError);

      const res = await sendManualReminder({
        tokenHash: 'active_token_hash',
        idempotencyKey: 'idemp-404-test-key-1',
        targetSubscriptionIds: [subId],
      });

      expect(res.attempt.outcome).toBe('rejected');
      expect(res.results[0]?.statusCode).toBe(404);

      const [directSub] = await db.select().from(pushSubscriptions);
      expect(directSub?.status).toBe('disabled');
    });
  });
});
